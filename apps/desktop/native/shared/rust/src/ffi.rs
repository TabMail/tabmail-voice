// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::privacy;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::Once,
};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLY_BYTES: usize = 128 * 1024 * 1024;

#[repr(C)]
pub struct Buffer {
    pub data: *mut u8,
    pub length: usize,
}

impl Buffer {
    fn empty() -> Self {
        Self {
            data: std::ptr::null_mut(),
            length: 0,
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn voice_core_abi_version() -> u32 {
    1
}

fn guarded<T>(operation: impl FnOnce() -> Result<T, u32>) -> Result<T, u32> {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| std::panic::set_hook(Box::new(|_| {})));
    catch_unwind(AssertUnwindSafe(operation)).map_err(|_| 2u32)?
}

/// The caller supplies valid readable input and a writable output slot, with no
/// overlap. On success, free the returned buffer exactly once using this library.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_redact_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe {
        process(data, length, output, |input| {
            let lines: privacy::Lines = serde_json::from_slice(input).map_err(|_| 1u32)?;
            let redacted = privacy::redact(&lines).map_err(|_| 3u32)?;
            let bytes = serde_json::to_vec(&redacted).map_err(|_| 3u32)?;
            Ok(bytes)
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_context_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::context::process) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_request_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::request::process) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_walk_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::walk::process) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_screen_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::screen::process) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_address_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::address::process) }
}

/// Project approved visible terminal ranges; never accepts hidden recognition halos.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_viewport_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::viewport::process) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_policy_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe { process(data, length, output, crate::policy::process) }
}

/// The most explicit document text one request takes, with its context, in UTF-8
/// bytes (the app's `redactionTextMaxBytes`).
const DOCUMENT_TEXT_BYTES: usize = 128 * 1024;

/// Explicit local-document text, independent of screen-exclusion policy. The
/// application must authorize its file read before requesting this operation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_redact_text_json(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
) -> u32 {
    unsafe {
        process(data, length, output, |input| {
            let value: serde_json::Value = serde_json::from_slice(input).map_err(|_| 1u32)?;
            let field = |name: &str, required: bool| match value.get(name) {
                None if !required => Ok(""),
                value => value.and_then(serde_json::Value::as_str).ok_or(1u32),
            };
            let text = field("text", true)?;
            // Part of a document comes with the text around it, so that a secret
            // continuing past an edge is recognized whole. The three are redacted as one
            // text and only the middle is returned; a match crossing an edge is replaced
            // whole, so none of its characters is left on either side.
            let (before, after) = (field("before", false)?, field("after", false)?);
            if before.len() + text.len() + after.len() > DOCUMENT_TEXT_BYTES {
                return Err(1);
            }
            let parts = vec![vec![before.to_owned(), text.to_owned(), after.to_owned()]];
            let result = privacy::redact(&parts).map_err(|_| 3u32)?;
            serde_json::to_vec(&serde_json::json!({"text": result[0][1]})).map_err(|_| 3)
        })
    }
}

unsafe fn process(
    data: *const u8,
    length: usize,
    output: *mut Buffer,
    operation: impl FnOnce(&[u8]) -> Result<Vec<u8>, u32>,
) -> u32 {
    if output.is_null() {
        return 1;
    }
    unsafe {
        output.write(Buffer::empty());
    }
    if data.is_null() || length == 0 || length > MAX_REQUEST_BYTES {
        return 1;
    }
    let result = guarded(|| {
        let input = unsafe { std::slice::from_raw_parts(data, length) };
        #[cfg(test)]
        if input == b"test-panic" && std::env::var_os("VOICE_CORE_PANIC_CHILD").is_some() {
            panic!("synthetic-private-panic-sentinel");
        }
        let bytes = operation(input)?;
        if bytes.len() > MAX_REPLY_BYTES {
            return Err(3);
        }
        Ok(bytes)
    });
    unsafe { deliver(output, result) }
}

unsafe fn deliver(output: *mut Buffer, result: Result<Vec<u8>, u32>) -> u32 {
    match result {
        Ok(bytes) => {
            let mut boxed = bytes.into_boxed_slice();
            let buffer = Buffer {
                data: boxed.as_mut_ptr(),
                length: boxed.len(),
            };
            std::mem::forget(boxed);
            unsafe {
                output.write(buffer);
            }
            0
        }
        Err(status) => status,
    }
}

/// All handle calls require an exclusively owned live handle from this library.
/// The native wrapper must stop acquisition when the returned decision says so.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_semantic_new(
    kind: u32,
    output: *mut *mut crate::semantic::SemanticText,
    decision: *mut u32,
) -> u32 {
    if output.is_null() || decision.is_null() {
        return 1;
    }
    unsafe {
        output.write(std::ptr::null_mut());
        decision.write(0);
    }
    match guarded(|| crate::semantic::SemanticText::new(kind).map(Box::new)) {
        Ok(state) => {
            unsafe {
                decision.write(state.decision() as u32);
                output.write(Box::into_raw(state));
            }
            0
        }
        Err(status) => status,
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_semantic_offer(
    state: *mut crate::semantic::SemanticText,
    event: u32,
    data: *const u8,
    length: usize,
    decision: *mut u32,
) -> u32 {
    if decision.is_null() {
        return 1;
    }
    unsafe {
        decision.write(0);
    }
    if state.is_null() {
        return 1;
    }
    let state = unsafe { &mut *state };
    let result = guarded(|| {
        if length > crate::semantic::MAX_BYTES || (length > 0 && data.is_null()) {
            return Err(1);
        }
        let bytes = if length == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(data, length) }
        };
        let text = std::str::from_utf8(bytes).map_err(|_| 1u32)?;
        state.offer(event, text)
    });
    match result {
        Ok(next) => {
            unsafe {
                decision.write(next as u32);
            }
            0
        }
        Err(status) => {
            state.refuse();
            status
        }
    }
}
/// Returns approved SOURCE text, not redacted or presentation-clipped text.
/// Keep it private and pass it to combined-screen redaction before publishing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_semantic_finish(
    state: *const crate::semantic::SemanticText,
    output: *mut Buffer,
) -> u32 {
    if output.is_null() {
        return 1;
    }
    unsafe {
        output.write(Buffer::empty());
    }
    if state.is_null() {
        return 1;
    }
    let result = guarded(|| unsafe { (&*state).finish().map(|text| text.as_bytes().to_vec()) });
    unsafe { deliver(output, result) }
}
/// A projected offer is a JSON array [private-before, visible, private-after].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_semantic_offer_projected(
    state: *mut crate::semantic::SemanticText,
    event: u32,
    data: *const u8,
    length: usize,
    decision: *mut u32,
) -> u32 {
    if decision.is_null() {
        return 1;
    }
    unsafe {
        decision.write(0);
    }
    if state.is_null() {
        return 1;
    }
    let state = unsafe { &mut *state };
    let result = guarded(|| {
        if data.is_null() || length == 0 || length > MAX_REQUEST_BYTES {
            return Err(1);
        }
        let parts: Vec<String> =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(data, length) })
                .map_err(|_| 1u32)?;
        state.offer_projected(event, parts)
    });
    match result {
        Ok(next) => {
            unsafe {
                decision.write(next as u32);
            }
            0
        }
        Err(status) => {
            state.refuse();
            status
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_semantic_finish_projected(
    state: *const crate::semantic::SemanticText,
    output: *mut Buffer,
) -> u32 {
    if output.is_null() {
        return 1;
    }
    unsafe {
        output.write(Buffer::empty());
    }
    if state.is_null() {
        return 1;
    }
    let result = guarded(|| unsafe { (&*state).finish_projected() });
    unsafe { deliver(output, result) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_semantic_free(state: *mut crate::semantic::SemanticText) {
    if !state.is_null() {
        unsafe {
            drop(Box::from_raw(state));
        }
    }
}

/// Exclusive acquisition owners. Offset units are native metadata, never policy.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_utf16_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe { source_new(count, start, end, output, crate::source::Source::new) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_scalar_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe { source_new(count, start, end, output, crate::source::Source::new_scalar) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_block_utf16_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe { source_new(count, start, end, output, crate::source::Source::block) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_block_scalar_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe {
        source_new(
            count,
            start,
            end,
            output,
            crate::source::Source::block_scalar,
        )
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_field_utf16_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe { source_new(count, start, end, output, crate::source::Source::field) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_field_scalar_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe {
        source_new(
            count,
            start,
            end,
            output,
            crate::source::Source::field_scalar,
        )
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_visible_field_utf16_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe {
        source_new(
            count,
            start,
            end,
            output,
            crate::source::Source::visible_field,
        )
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_visible_field_scalar_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
) -> u32 {
    unsafe {
        source_new(
            count,
            start,
            end,
            output,
            crate::source::Source::visible_field_scalar,
        )
    }
}
unsafe fn source_new(
    count: usize,
    start: usize,
    end: usize,
    output: *mut *mut crate::source::Source,
    create: fn(usize, usize, usize) -> Result<crate::source::Source, u32>,
) -> u32 {
    if output.is_null() {
        return 1;
    }
    unsafe {
        output.write(std::ptr::null_mut());
    }
    match guarded(|| create(count, start, end).map(Box::new)) {
        Ok(state) => {
            unsafe {
                output.write(Box::into_raw(state));
            }
            0
        }
        Err(status) => status,
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_next(
    state: *const crate::source::Source,
    start: *mut usize,
    length: *mut usize,
) -> u32 {
    if start.is_null() || length.is_null() {
        return 1;
    }
    unsafe {
        start.write(0);
        length.write(0);
    }
    if state.is_null() {
        return 1;
    }
    match guarded(|| unsafe { (&*state).next() }) {
        Ok(next) => {
            if let Some((at, count)) = next {
                unsafe {
                    start.write(at);
                    length.write(count);
                }
            }
            0
        }
        Err(status) => status,
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_utf16_offer(
    state: *mut crate::source::Source,
    data: *const u16,
    length: usize,
) -> u32 {
    if state.is_null() {
        return 1;
    }
    let state = unsafe { &mut *state };
    let result = guarded(|| {
        if length > crate::source::CHUNK_UNITS || (length > 0 && data.is_null()) {
            return Err(1);
        }
        let units = if length == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(data, length) }
        };
        state.offer(units)
    });
    match result {
        Ok(()) => 0,
        Err(status) => {
            state.refuse();
            status
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_utf8_offer(
    state: *mut crate::source::Source,
    data: *const u8,
    length: usize,
) -> u32 {
    if state.is_null() {
        return 1;
    }
    let state = unsafe { &mut *state };
    let result = guarded(|| {
        if length > 4 * crate::source::CHUNK_UNITS || (length > 0 && data.is_null()) {
            return Err(1);
        }
        let bytes = if length == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(data, length) }
        };
        let text = std::str::from_utf8(bytes).map_err(|_| 1u32)?;
        state.offer_utf8(text)
    });
    match result {
        Ok(()) => 0,
        Err(status) => {
            state.refuse();
            status
        }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_finish(
    state: *const crate::source::Source,
    output: *mut Buffer,
) -> u32 {
    if output.is_null() {
        return 1;
    }
    unsafe {
        output.write(Buffer::empty());
    }
    if state.is_null() {
        return 1;
    }
    let result = guarded(|| unsafe { (&*state).finish() });
    unsafe { deliver(output, result) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_source_free(state: *mut crate::source::Source) {
    if !state.is_null() {
        unsafe {
            drop(Box::from_raw(state));
        }
    }
}

/// Accepts an empty buffer or one returned by voice_core_redact_json, unchanged.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_buffer_free(buffer: Buffer) {
    if !buffer.data.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                buffer.data,
                buffer.length,
            )));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn field_ffi_owns_output_and_refuses_invalid_ranges() {
        for scalar in [false, true] {
            unsafe {
                let create = if scalar {
                    voice_core_field_scalar_new
                } else {
                    voice_core_field_utf16_new
                };
                let mut state = std::ptr::null_mut();
                assert_eq!(create(1, 0, 2, &mut state), 1);
                assert!(state.is_null());
                assert_eq!(create(0, 0, 0, std::ptr::null_mut()), 1);
                assert_eq!(create(2, 0, 2, &mut state), 0);
                let mut output = Buffer::empty();
                assert_eq!(voice_core_source_finish(state, &mut output), 1);
                assert!(output.data.is_null());
                let mut start = 99;
                let mut length = 99;
                assert_eq!(voice_core_source_next(state, &mut start, &mut length), 0);
                assert_eq!((start, length), (0, 2));
                if scalar {
                    assert_eq!(voice_core_source_utf8_offer(state, b"ok".as_ptr(), 2), 0);
                } else {
                    assert_eq!(
                        voice_core_source_utf16_offer(state, [111, 107].as_ptr(), 2),
                        0
                    );
                }
                assert_eq!(voice_core_source_finish(state, &mut output), 0);
                let result: serde_json::Value =
                    serde_json::from_slice(std::slice::from_raw_parts(output.data, output.length))
                        .unwrap();
                assert_eq!(result, serde_json::json!({"text":"ok","complete":true}));
                voice_core_buffer_free(output);
                voice_core_source_free(state);
            }
        }
    }
    #[test]
    fn common_semantic_corpus_through_owned_ffi() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../context/semantic-cases.json")).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() >= 11);
        for case in cases {
            let mut state = std::ptr::null_mut();
            let mut decision = 0;
            assert_eq!(
                unsafe {
                    voice_core_semantic_new(
                        case["kind"].as_u64().unwrap() as u32,
                        &mut state,
                        &mut decision,
                    )
                },
                0
            );
            assert_eq!(decision, case["initial"].as_u64().unwrap() as u32);
            for event in case["events"].as_array().unwrap() {
                let text = event["text"]
                    .as_str()
                    .unwrap()
                    .repeat(event["repeat"].as_u64().unwrap() as usize);
                assert_eq!(
                    unsafe {
                        voice_core_semantic_offer(
                            state,
                            event["event"].as_u64().unwrap() as u32,
                            text.as_ptr(),
                            text.len(),
                            &mut decision,
                        )
                    },
                    0
                );
                assert_eq!(
                    decision,
                    event["decision"].as_u64().unwrap() as u32,
                    "{}",
                    case["name"]
                );
            }
            let mut output = Buffer::empty();
            assert_eq!(unsafe { voice_core_semantic_finish(state, &mut output) }, 0);
            let actual = unsafe { std::slice::from_raw_parts(output.data, output.length) };
            let expected = case["expected"]["text"]
                .as_str()
                .unwrap()
                .repeat(case["expected"]["repeat"].as_u64().unwrap() as usize);
            assert_eq!(actual, expected.as_bytes(), "{}", case["name"]);
            unsafe {
                voice_core_buffer_free(output);
                voice_core_semantic_free(state);
            }
        }
    }
    #[test]
    fn projected_semantic_ffi_roundtrip_and_poisoned_owner() {
        for invalid in [false, true] {
            let mut state = std::ptr::null_mut();
            let mut decision = 0;
            assert_eq!(
                unsafe { voice_core_semantic_new(2, &mut state, &mut decision) },
                0
            );
            let input = if invalid {
                br#"["only two", "parts"]"#.as_slice()
            } else {
                br#"["password: ","syntheticSecret123",""]"#.as_slice()
            };
            assert_eq!(
                unsafe {
                    voice_core_semantic_offer_projected(
                        state,
                        1,
                        input.as_ptr(),
                        input.len(),
                        &mut decision,
                    )
                },
                if invalid { 1 } else { 0 }
            );
            let mut output = Buffer::empty();
            assert_eq!(unsafe { voice_core_semantic_finish(state, &mut output) }, 1);
            assert!(output.data.is_null());
            assert_eq!(
                unsafe { voice_core_semantic_finish_projected(state, &mut output) },
                if invalid { 1 } else { 0 }
            );
            if !invalid {
                let result: serde_json::Value = serde_json::from_slice(unsafe {
                    std::slice::from_raw_parts(output.data, output.length)
                })
                .unwrap();
                assert_eq!(result["text"], "syntheticSecret123");
                assert_eq!(
                    result["runs"],
                    serde_json::json!([["password: ", false], ["syntheticSecret123", true]])
                );
            } else {
                assert!(output.data.is_null());
                assert_eq!(decision, 0);
            }
            unsafe {
                voice_core_buffer_free(output);
                voice_core_semantic_free(state);
            }
        }
    }
    #[test]
    fn semantic_ffi_refuses_invalid_utf8_and_poisoned_finish() {
        let mut state = std::ptr::null_mut();
        let mut decision = 99;
        assert_eq!(
            unsafe { voice_core_semantic_new(0, &mut state, &mut decision) },
            1
        );
        assert!(state.is_null());
        assert_eq!(decision, 0);
        let invalid_utf8 = [0xff];
        for (data, length) in [
            (std::ptr::null(), 1),
            (b"x".as_ptr(), crate::semantic::MAX_BYTES + 1),
            (invalid_utf8.as_ptr(), 1),
        ] {
            assert_eq!(
                unsafe { voice_core_semantic_new(1, &mut state, &mut decision) },
                0
            );
            assert_eq!(
                unsafe { voice_core_semantic_offer(state, 2, data, length, &mut decision) },
                1
            );
            assert_eq!(decision, 0);
            let mut output = Buffer::empty();
            assert_eq!(unsafe { voice_core_semantic_finish(state, &mut output) }, 1);
            assert!(output.data.is_null());
            assert_eq!(output.length, 0);
            unsafe {
                voice_core_semantic_free(state);
            }
        }
        unsafe {
            voice_core_semantic_free(std::ptr::null_mut());
        }
    }
    #[test]
    fn ffi_refuses_invalid_input_and_owns_output() {
        for input in [b"not json".as_slice(), &[0xff], b"[42]", b"null"] {
            let mut output = Buffer::empty();
            assert_eq!(
                unsafe { voice_core_redact_json(input.as_ptr(), input.len(), &mut output) },
                1
            );
            assert!(output.data.is_null());
            assert_eq!(output.length, 0);
        }
        for _ in 0..100 {
            let input = br#"[["hello"]]"#;
            let mut output = Buffer::empty();
            assert_eq!(
                unsafe { voice_core_redact_json(input.as_ptr(), input.len(), &mut output) },
                0
            );
            assert_eq!(
                unsafe { std::slice::from_raw_parts(output.data, output.length) },
                input
            );
            unsafe {
                voice_core_buffer_free(output);
            }
        }
        let mut output = Buffer::empty();
        assert_eq!(
            unsafe { voice_core_redact_json(std::ptr::null(), 1, &mut output) },
            1
        );
        assert_eq!(
            unsafe { voice_core_redact_json(b"x".as_ptr(), MAX_REQUEST_BYTES + 1, &mut output) },
            1
        );
        assert_eq!(
            unsafe { voice_core_redact_json(b"x".as_ptr(), 1, std::ptr::null_mut()) },
            1
        );
        unsafe {
            voice_core_buffer_free(Buffer::empty());
        }
    }
    #[test]
    fn no_key_line_is_returned_whatever_the_pages_read_and_their_layout() {
        // A key printed across three pages, read as the PDF reader does: the pages asked for,
        // joined by a blank line, with the end of the page before and the page after as context.
        let line = |page: usize, row: usize| {
            format!("Qx7Lm2Vp9Rt4Wz8Kc3Nf6Hj1Bd5Gs0Ya+Te/Uo2Ie9Pr4Mw7Lk3Ji6Hu1Gy5Ft0Dr{page}{row}")
        };
        for layout in ["footer", "header", "none"] {
            let pages = (1..=3)
                .map(|number| {
                    let mut lines = (0..3).map(|row| line(number, row)).collect::<Vec<_>>();
                    if number == 1 {
                        lines.splice(
                            0..0,
                            ["Key backup".into(), "-----BEGIN PRIVATE KEY-----".into()],
                        );
                    }
                    if number == 3 {
                        lines.push("-----END PRIVATE KEY-----".into());
                    }
                    match layout {
                        "footer" => lines.push(format!("Page {number} of 3")),
                        "header" => lines.insert(0, format!("Key backup, page {number} of 3")),
                        _ => {}
                    }
                    lines.join("\n")
                })
                .collect::<Vec<_>>();
            for (first, last) in [(1, 3), (1, 2), (2, 2), (2, 3), (3, 3)] {
                let before = if first > 1 {
                    format!("{}\n\n", pages[first - 2])
                } else {
                    String::new()
                };
                let text = pages[first - 1..last].join("\n\n");
                let after = if last < 3 {
                    format!("\n\n{}", pages[last])
                } else {
                    String::new()
                };
                let input = serde_json::to_vec(
                    &serde_json::json!({"before": before, "text": text, "after": after}),
                )
                .unwrap();
                let mut output = Buffer::empty();
                let status = unsafe {
                    voice_core_redact_text_json(input.as_ptr(), input.len(), &mut output)
                };
                assert_eq!(status, 0);
                let bytes = unsafe { std::slice::from_raw_parts(output.data, output.length) };
                let reply: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                let returned = reply["text"].as_str().unwrap().to_owned();
                unsafe {
                    voice_core_buffer_free(output);
                }
                for number in 1..=3 {
                    for row in 0..3 {
                        assert!(
                            !returned.contains(&line(number, row)[..40]),
                            "{layout} layout, pages {first}-{last}: a key line was returned"
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn explicit_text_redaction_is_bounded_and_refuses_bad_shapes() {
        let limit = "a".repeat(DOCUMENT_TEXT_BYTES / 2);
        for (input, expected) in [
            (
                serde_json::json!({"text": "token=syntheticPrivate123"}),
                Some("token=[redacted]"),
            ),
            (serde_json::json!({"text": ""}), Some("")),
            (
                // A secret continuing from the text before is recognized and left out.
                serde_json::json!({"before": "token=", "text": "syntheticPrivate123. Public."}),
                Some("[redacted] Public."),
            ),
            (
                serde_json::json!({"before": "Earlier. token=synthetic", "text": "Private123. Public."}),
                Some(" Public."),
            ),
            (
                // A secret continuing into the text after leaves only its replacement.
                serde_json::json!({"text": "Public. token=synthetic", "after": "Private123 later."}),
                Some("Public. token=[redacted]"),
            ),
            (
                // Text with no sentence delimiter is returned whole.
                serde_json::json!({"before": "前のページ", "text": "会議は金曜日です。資料を確認してください。", "after": "次のページ"}),
                Some("会議は金曜日です。資料を確認してください。"),
            ),
            (
                serde_json::json!({"before": "", "text": "Public.", "after": ""}),
                Some("Public."),
            ),
            (
                serde_json::json!({"before": limit, "text": "", "after": limit}),
                Some(""),
            ),
            (
                serde_json::json!({"before": limit, "text": "a", "after": limit}),
                None,
            ),
            (serde_json::json!({"text": "Public.", "before": null}), None),
            (serde_json::json!({"text": "Public.", "after": true}), None),
            (serde_json::json!({}), None),
            (serde_json::json!({"text": null}), None),
            (serde_json::json!({"text": "😀".repeat(32769)}), None),
        ] {
            let input = serde_json::to_vec(&input).unwrap();
            let mut output = Buffer::empty();
            let status =
                unsafe { voice_core_redact_text_json(input.as_ptr(), input.len(), &mut output) };
            if let Some(text) = expected {
                assert_eq!(status, 0);
                let bytes = unsafe { std::slice::from_raw_parts(output.data, output.length) };
                let reply: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(reply, serde_json::json!({"text": text}));
            } else {
                assert_eq!(status, 1);
                assert!(output.data.is_null());
                assert_eq!(output.length, 0);
            }
            unsafe {
                voice_core_buffer_free(output);
            }
        }
    }

    #[test]
    fn panic_child() {
        if std::env::var_os("VOICE_CORE_PANIC_CHILD").is_none() {
            return;
        }
        let input = b"test-panic";
        let mut output = Buffer::empty();
        assert_eq!(
            unsafe { voice_core_redact_json(input.as_ptr(), input.len(), &mut output) },
            2
        );
        assert!(output.data.is_null());
        assert_eq!(output.length, 0);
    }
    #[test]
    fn panic_payload_never_reaches_stderr() {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ffi::tests::panic_child", "--nocapture"])
            .env("VOICE_CORE_PANIC_CHILD", "1")
            .output()
            .unwrap();
        assert!(child.status.success());
        assert!(
            !String::from_utf8_lossy(&child.stderr).contains("synthetic-private-panic-sentinel")
        );
    }
    #[test]
    fn engine_failure_child() {
        if std::env::var_os("VOICE_CORE_ENGINE_CHILD").is_none() {
            return;
        }
        let text = format!(
            "token={}\npassword:{}x private-tail-sentinel",
            "abc123def",
            " ".repeat(1_000_100)
        );
        let input = serde_json::to_vec(&vec![vec![text]]).unwrap();
        let mut output = Buffer::empty();
        assert_eq!(
            unsafe { voice_core_redact_json(input.as_ptr(), input.len(), &mut output) },
            0
        );
        let bytes = unsafe { std::slice::from_raw_parts(output.data, output.length) };
        assert!(!String::from_utf8_lossy(bytes).contains("private-tail-sentinel"));
        unsafe {
            voice_core_buffer_free(output);
        }
    }
    #[test]
    fn engine_failure_logs_only_the_canonical_name() {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ffi::tests::engine_failure_child", "--nocapture"])
            .env("VOICE_CORE_ENGINE_CHILD", "1")
            .output()
            .unwrap();
        assert!(child.status.success());
        assert_eq!(
            String::from_utf8(child.stderr).unwrap(),
            "debug redactor unfinished: named-value\n"
        );
    }
}

#[cfg(test)]
mod source_abi_tests {
    use super::*;
    #[test]
    fn scalar_abi_roundtrip_counts_characters_and_preserves_utf8() {
        let text = "a😀e\u{301}日本語".repeat(9000);
        let offsets: Vec<_> = text
            .char_indices()
            .map(|(at, _)| at)
            .chain([text.len()])
            .collect();
        let mut state = std::ptr::null_mut();
        unsafe {
            assert_eq!(
                voice_core_source_scalar_new(offsets.len() - 1, 0, offsets.len() - 1, &mut state),
                0
            );
            loop {
                let (mut start, mut length) = (0, 0);
                assert_eq!(voice_core_source_next(state, &mut start, &mut length), 0);
                if length == 0 {
                    break;
                }
                let chunk = &text.as_bytes()[offsets[start]..offsets[start + length]];
                assert_eq!(
                    voice_core_source_utf8_offer(state, chunk.as_ptr(), chunk.len()),
                    0
                );
            }
            let mut output = Buffer::empty();
            assert_eq!(voice_core_source_finish(state, &mut output), 0);
            let value: serde_json::Value =
                serde_json::from_slice(std::slice::from_raw_parts(output.data, output.length))
                    .unwrap();
            assert_eq!(value["parts"], serde_json::json!(["", text, ""]));
            voice_core_buffer_free(output);
            voice_core_source_free(state);
        }
    }
    #[test]
    fn scalar_abi_bad_utf8_short_null_and_oversized_offers_poison() {
        let bad = [0xffu8];
        let short = b"x";
        for (data, length) in [
            (bad.as_ptr(), bad.len()),
            (short.as_ptr(), short.len()),
            (std::ptr::null(), 2),
            (std::ptr::null(), 4 * crate::source::CHUNK_UNITS + 1),
        ] {
            let mut state = std::ptr::null_mut();
            unsafe {
                assert_eq!(voice_core_source_scalar_new(2, 0, 2, &mut state), 0);
                assert_eq!(voice_core_source_utf8_offer(state, data, length), 1);
                let (mut start, mut length) = (8, 8);
                assert_eq!(voice_core_source_next(state, &mut start, &mut length), 1);
                assert_eq!((start, length), (0, 0));
                let mut output = Buffer::empty();
                assert_eq!(voice_core_source_finish(state, &mut output), 1);
                assert!(output.data.is_null());
                voice_core_source_free(state);
            }
        }
    }
    #[test]
    fn source_utf16_abi_roundtrip_retains_complete_selection() {
        let selected = "a😀e\u{301}".repeat(7000);
        let text = format!("Before {selected} after");
        let units: Vec<_> = text.encode_utf16().collect();
        let mut state = std::ptr::null_mut();
        unsafe {
            assert_eq!(
                voice_core_source_utf16_new(
                    units.len(),
                    7,
                    7 + selected.encode_utf16().count(),
                    &mut state
                ),
                0
            );
            loop {
                let (mut start, mut length) = (0, 0);
                assert_eq!(voice_core_source_next(state, &mut start, &mut length), 0);
                if length == 0 {
                    break;
                }
                assert!(length <= crate::source::CHUNK_UNITS);
                assert_eq!(
                    voice_core_source_utf16_offer(
                        state,
                        units[start..start + length].as_ptr(),
                        length
                    ),
                    0
                );
            }
            let mut output = Buffer::empty();
            assert_eq!(voice_core_source_finish(state, &mut output), 0);
            let value: serde_json::Value =
                serde_json::from_slice(std::slice::from_raw_parts(output.data, output.length))
                    .unwrap();
            assert_eq!(
                value["parts"],
                serde_json::json!(["Before ", selected, " after"])
            );
            voice_core_buffer_free(output);
            voice_core_source_free(state);
        }
    }
    #[test]
    fn source_utf16_invalid_offer_poisoning_and_empty_outputs() {
        for length in [0, 9, 10, crate::source::CHUNK_UNITS + 1] {
            let mut state = std::ptr::null_mut();
            unsafe {
                assert_eq!(voice_core_source_utf16_new(10, 0, 10, &mut state), 0);
                let mut output = Buffer::empty();
                assert_eq!(voice_core_source_finish(state, &mut output), 1);
                assert!(output.data.is_null());
                assert_eq!(
                    voice_core_source_utf16_offer(state, std::ptr::null(), length),
                    1
                );
                let (mut start, mut count) = (99, 99);
                assert_eq!(voice_core_source_next(state, &mut start, &mut count), 1);
                assert_eq!((start, count), (0, 0));
                assert_eq!(voice_core_source_finish(state, &mut output), 1);
                assert!(output.data.is_null());
                assert_eq!(output.length, 0);
                voice_core_source_free(state);
            }
        }
    }
    #[test]
    fn source_utf16_invalid_creation_and_null_owner_are_refused() {
        let mut state = std::ptr::null_mut();
        unsafe {
            assert_eq!(voice_core_source_utf16_new(1, 0, 2, &mut state), 1);
            assert!(state.is_null());
            let (mut start, mut count) = (99, 99);
            assert_eq!(voice_core_source_next(state, &mut start, &mut count), 1);
            assert_eq!((start, count), (0, 0));
            let mut output = Buffer::empty();
            assert_eq!(voice_core_source_finish(state, &mut output), 1);
            assert!(output.data.is_null());
            voice_core_source_free(state);
        }
    }
}
