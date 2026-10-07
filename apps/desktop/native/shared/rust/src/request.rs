// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Request rules every helper shares (ADR-DESK-054): the bound of a focused field's read for
//! correction learning and its reply, a paste's text and deadline, and a microphone start's or
//! stop's session and rate. The helper reads the field and checks it is no password field itself;
//! the core decides what of it is sent.

use serde_json::{Value, json};

/// The longest focused field a request may ask to read, in UTF-16 code units.
const FIELD_MAX_LENGTH: u64 = 20_000;
/// The most text one paste carries, in UTF-8 bytes.
const INSERT_TEXT_BYTES: usize = 512 * 1024;
/// How far past the helper's clock a paste's deadline may be, in milliseconds.
const INSERT_DEADLINE_MILLISECONDS: i64 = 5_000;
/// The recording rates a microphone start may ask for, in whole hertz.
const MICROPHONE_SAMPLE_RATES: std::ops::RangeInclusive<u64> = 8_000..=96_000;

/// `{"field": {"maxLength": n}}` → `{"maxLength": n}` when n is 1 to 20,000; with `"text"` (the
/// field's text as read, or null for none) → `{"value": …}`: null for none or one longer than n
/// UTF-16 units, or one a break the core added could split a secret in, else the text with
/// secret-looking text taken out. With `"viewport"` instead (a terminal's, as the screen read sends
/// it) the field is the box around the terminal's cursor (`terminal_box`), its rows joined by
/// breaks the core adds, given as U+2029 so the app can tell a row the terminal wrapped from the
/// user's own line break: a terminal's whole text is its scrollback, and its other panes and
/// programs' lines are not the text the dictation went into. None without an exact caret.
fn field(request: &Value) -> Result<Value, u32> {
    let bound = request
        .get("maxLength")
        .and_then(Value::as_u64)
        .filter(|bound| (1..=FIELD_MAX_LENGTH).contains(bound))
        .ok_or(1u32)?;
    let boxed;
    let text = match (request.get("text"), request.get("viewport")) {
        (text, None) => text,
        (None, Some(viewport)) => {
            let bytes = serde_json::to_vec(viewport).map_err(|_| 3u32)?;
            let projected: Value =
                serde_json::from_slice(&crate::viewport::process(&bytes)?).map_err(|_| 3u32)?;
            // The rows were cut from text redacted as it was on screen, between other panes' text;
            // joined by the core's own breaks, they are checked again with and without them.
            boxed = crate::terminal_box::caret_box(&projected).map_or(Value::Null, |caret| {
                let mut rows = caret.above;
                rows.push(caret.before + &caret.after);
                rows.extend(caret.below);
                Value::String(rows.join(&crate::context::ADDED_BREAK.to_string()))
            });
            Some(&boxed)
        }
        _ => return Err(1),
    };
    let terminal = request.get("viewport").is_some();
    Ok(match text {
        None => json!({"maxLength": bound}),
        Some(Value::Null) => json!({"value": null}),
        Some(Value::String(text)) if text.encode_utf16().count() as u64 > bound => {
            json!({"value": null})
        }
        // A rich editor's breaks are the core's (`hypertext`): a value one of them could split a
        // secret in is withheld, as the render withholds it.
        Some(Value::String(text)) => {
            let (redacted, withheld) = crate::context::redact_added(&vec![vec![text.clone()]])?;
            if withheld[0] {
                json!({"value": null})
            } else if terminal {
                // A box's rows hold no line break of their own: every one is the core's.
                json!({"value": redacted[0][0].replace('\n', &crate::context::ADDED_BREAK.to_string())})
            } else {
                json!({"value": redacted[0][0]})
            }
        }
        Some(_) => return Err(1),
    })
}

/// `{"insert": {"text": t}}` → `{}` when t is pasteable (not empty, at most 512 KiB, no NUL); with
/// `"deadline"` and `"now"` (Unix milliseconds) also the deadline, no later than 5 s from now →
/// `{"wait": milliseconds left}`.
fn insert(request: &Value) -> Result<Value, u32> {
    let text = request.get("text").and_then(Value::as_str).ok_or(1u32)?;
    if text.is_empty() || text.len() > INSERT_TEXT_BYTES || text.contains('\0') {
        return Err(1);
    }
    match (request.get("deadline"), request.get("now")) {
        (None, None) => Ok(json!({})),
        (Some(deadline), Some(now)) => {
            let deadline = deadline.as_i64().ok_or(1u32)?;
            let now = now.as_i64().ok_or(1u32)?;
            let wait = deadline.checked_sub(now).ok_or(1u32)?;
            if wait <= 0 || wait > INSERT_DEADLINE_MILLISECONDS {
                return Err(1);
            }
            Ok(json!({"wait": wait}))
        }
        _ => Err(1),
    }
}

/// `{"microphoneStop": {"session": s}}` → `{"session": s}` when s is a whole number from 1;
/// `{"microphoneStart": {"session": s, "sampleRate": r}}` → `{"session": s, "sampleRate": r}` when r
/// is also a whole number of hertz from 8,000 to 96,000. The session's order is `microphone`'s.
fn microphone(request: &Value, start: bool) -> Result<Value, u32> {
    let session = request
        .get("session")
        .and_then(Value::as_i64)
        .filter(|session| *session > 0)
        .ok_or(1u32)?;
    if !start {
        return Ok(json!({"session": session}));
    }
    let rate = request
        .get("sampleRate")
        .and_then(Value::as_u64)
        .filter(|rate| MICROPHONE_SAMPLE_RATES.contains(rate))
        .ok_or(1u32)?;
    Ok(json!({"session": session, "sampleRate": rate}))
}

pub(crate) fn process(bytes: &[u8]) -> Result<Vec<u8>, u32> {
    let input: Value = serde_json::from_slice(bytes).map_err(|_| 1u32)?;
    let object = input
        .as_object()
        .filter(|object| object.len() == 1)
        .ok_or(1u32)?;
    let reply = match object.iter().next() {
        Some((key, request)) if key == "field" => field(request)?,
        Some((key, request)) if key == "insert" => insert(request)?,
        Some((key, request)) if key == "microphoneStart" => microphone(request, true)?,
        Some((key, request)) if key == "microphoneStop" => microphone(request, false)?,
        _ => return Err(1),
    };
    serde_json::to_vec(&reply).map_err(|_| 3)
}

#[cfg(test)]
mod tests;
