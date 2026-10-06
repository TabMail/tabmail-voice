// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use serde_json::json;
use std::collections::VecDeque;

pub const CHUNK_UNITS: usize = 4096;
/// The most a caret source's `caretStarts` may take as JSON: two flags and a line's first
/// `CARET_LINE_BYTES`, escaped.
pub const CARET_STARTS_BYTES: usize = 256;
/// The most paragraph starts a caret source takes: each is a distinct offset within
/// `PARAGRAPH_START_UNITS` of the selection, or in it.
pub const PARAGRAPH_STARTS: usize =
    2 * crate::context::PARAGRAPH_START_UNITS + crate::context::SELECTION_SOURCE_BYTES + 1;
/// One bounded acquisition policy for exact UTF-16 or Unicode-scalar offsets.
/// Native adapters supply only requested spans and recheck provider identity.
#[derive(Clone, Copy, PartialEq)]
enum OffsetUnit {
    Utf16,
    Scalar,
}
pub struct Source {
    offset_unit: OffsetUnit,
    source_limit: usize,
    field_edges: Option<[bool; 2]>,
    complete: bool,
    projected: bool,
    ranges: [(usize, usize, bool); 3],
    phase: usize,
    cursor: usize,
    units: VecDeque<u16>,
    bytes: usize,
    parts: [String; 3],
    edges: [bool; 2],
    unavailable: bool,
    failed: bool,
    caret_starts: Option<serde_json::Value>,
    paragraph_starts: Option<Vec<usize>>,
    caret_ends_line: bool,
}
fn high(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}
fn low(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}
impl Source {
    pub fn new(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        Self::create(count, start, end, false, false)
    }
    fn create(
        count: usize,
        start: usize,
        end: usize,
        field: bool,
        projected: bool,
    ) -> Result<Self, u32> {
        if start > end || end > count {
            return Err(1);
        }
        let mut state = Self {
            offset_unit: OffsetUnit::Utf16,
            source_limit: crate::context::SOURCE_WINDOW_BYTES,
            field_edges: field.then_some([start == 0, end == count]),
            complete: true,
            projected,
            ranges: if field && !projected {
                [(start, end, false), (start, start, true), (end, end, false)]
            } else {
                [(start, end, false), (start, 0, true), (end, count, false)]
            },
            phase: 0,
            cursor: start,
            units: VecDeque::new(),
            bytes: 0,
            parts: Default::default(),
            edges: [false; 2],
            unavailable: false,
            failed: false,
            caret_starts: None,
            paragraph_starts: None,
            caret_ends_line: false,
        };
        if !field && end - start > crate::context::SELECTION_SOURCE_BYTES {
            state.unavailable = true;
            state.phase = 3;
        }
        state.settle()?;
        Ok(state)
    }
    pub fn new_scalar(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        let mut state = Self::new(count, start, end)?;
        state.offset_unit = OffsetUnit::Scalar;
        Ok(state)
    }
    pub fn field(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        Self::create(count, start, end, true, false)
    }
    pub fn field_scalar(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        let mut state = Self::field(count, start, end)?;
        state.offset_unit = OffsetUnit::Scalar;
        Ok(state)
    }
    pub fn block(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        let mut state = Self::field(count, start, end)?;
        state.source_limit = crate::context::BLOCK_SOURCE_BYTES;
        Ok(state)
    }
    pub fn block_scalar(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        let mut state = Self::block(count, start, end)?;
        state.offset_unit = OffsetUnit::Scalar;
        Ok(state)
    }
    pub fn visible_field(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        Self::create(count, start, end, true, true)
    }
    pub fn visible_field_scalar(count: usize, start: usize, end: usize) -> Result<Self, u32> {
        let mut state = Self::visible_field(count, start, end)?;
        state.offset_unit = OffsetUnit::Scalar;
        Ok(state)
    }
    /// What starts at the caret, as the provider lays the text out (the caret window's
    /// `caretStarts`, ADR-DESK-007), which the caret window checks: only a caret source takes it,
    /// once, and never with paragraph starts.
    pub fn set_caret_starts(&mut self, starts: serde_json::Value) -> Result<(), u32> {
        if self.field_edges.is_some()
            || self.caret_starts.is_some()
            || self.paragraph_starts.is_some()
            || !starts.is_object()
        {
            return Err(1);
        }
        self.caret_starts = Some(starts);
        Ok(())
    }
    /// Where the provider starts each paragraph near the caret, in its offsets, ascending
    /// (ADR-DESK-007, 2026-10-06): the caret window puts back the break before each that its text
    /// leaves out. `caret_ends_line`: the selection starts at the end of the line above a
    /// paragraph that starts at its offset, so that break follows it. Only a caret source takes
    /// them, once, and never with what starts at the caret.
    pub fn set_paragraph_starts(
        &mut self,
        starts: &[usize],
        caret_ends_line: bool,
    ) -> Result<(), u32> {
        if self.field_edges.is_some()
            || self.paragraph_starts.is_some()
            || self.caret_starts.is_some()
            || starts.len() > PARAGRAPH_STARTS
            || starts.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(1);
        }
        self.paragraph_starts = Some(starts.to_vec());
        self.caret_ends_line = caret_ends_line;
        Ok(())
    }
    /// The paragraph starts inside what was read, as byte offsets into its parts joined: a start
    /// at the read's first character, whose break would come before it, has none.
    fn paragraph_bytes(&self) -> Vec<usize> {
        let Some(starts) = &self.paragraph_starts else {
            return Vec::new();
        };
        let units = |text: &str| match self.offset_unit {
            OffsetUnit::Utf16 => text.encode_utf16().count(),
            OffsetUnit::Scalar => text.chars().count(),
        };
        let Some(first) = self.ranges[0].0.checked_sub(units(&self.parts[0])) else {
            return Vec::new();
        };
        let text = self.parts.concat();
        let mut offsets = Vec::new();
        let mut wanted = starts
            .iter()
            .copied()
            .filter(|start| *start > first)
            .peekable();
        let mut unit = first;
        for (byte, character) in text.char_indices() {
            while wanted.next_if(|start| *start < unit).is_some() {}
            if wanted.next_if_eq(&unit).is_some() && byte > 0 {
                offsets.push(byte);
            }
            unit += match self.offset_unit {
                OffsetUnit::Utf16 => character.len_utf16(),
                OffsetUnit::Scalar => 1,
            };
        }
        if wanted.next_if_eq(&unit).is_some() && !text.is_empty() {
            offsets.push(text.len());
        }
        offsets
    }
    pub fn refuse(&mut self) {
        self.failed = true;
        self.units.clear();
        self.parts = Default::default();
    }
    pub fn next(&self) -> Result<Option<(usize, usize)>, u32> {
        if self.failed {
            return Err(1);
        }
        if self.phase == 3 {
            return Ok(None);
        }
        let (_, bound, backwards) = self.ranges[self.phase];
        let length = self.cursor.abs_diff(bound).min(CHUNK_UNITS);
        Ok(Some((
            if backwards {
                self.cursor - length
            } else {
                self.cursor
            },
            length,
        )))
    }
    pub fn offer(&mut self, chunk: &[u16]) -> Result<(), u32> {
        let result = if self.offset_unit == OffsetUnit::Utf16 {
            self.accept(chunk, chunk.len())
        } else {
            Err(1)
        };
        if result.is_err() {
            self.refuse();
        }
        result
    }
    pub fn offer_utf8(&mut self, chunk: &str) -> Result<(), u32> {
        let result = if self.offset_unit == OffsetUnit::Scalar && chunk.len() <= 4 * CHUNK_UNITS {
            let native_length = chunk.chars().count();
            let units: Vec<_> = chunk.encode_utf16().collect();
            self.accept(&units, native_length)
        } else {
            Err(1)
        };
        if result.is_err() {
            self.refuse();
        }
        result
    }
    fn accept(&mut self, chunk: &[u16], native_length: usize) -> Result<(), u32> {
        let (_, length) = self.next()?.ok_or(1u32)?;
        if native_length != length {
            return Err(1);
        }
        let (_, _, backwards) = self.ranges[self.phase];
        let mut bytes = String::from_utf16_lossy(chunk).len();
        let paired = if backwards {
            chunk.last().is_some_and(|v| high(*v)) && self.units.front().is_some_and(|v| low(*v))
        } else {
            self.units.back().is_some_and(|v| high(*v)) && chunk.first().is_some_and(|v| low(*v))
        };
        if paired {
            bytes -= 2;
        }
        let limit = if self.phase == 0 && self.field_edges.is_none() {
            crate::context::SELECTION_SOURCE_BYTES
        } else {
            self.source_limit
        };
        if bytes > limit - self.bytes {
            if self.field_edges.is_some() && self.phase == 0 {
                self.complete = false;
                // The omitted target tail is a gap, so never append source from
                // beyond it as though it were adjacent to the acquired prefix.
                let end = self.ranges[2].0;
                self.ranges[2] = (end, end, false);
                self.close(false)?;
            } else if self.phase == 0 {
                self.unavailable = true;
                self.phase = 3;
                self.units.clear();
            } else {
                self.close(false)?;
            }
        } else {
            self.bytes += bytes;
            if backwards {
                for unit in chunk.iter().rev() {
                    self.units.push_front(*unit);
                }
                self.cursor -= length;
            } else {
                self.units.extend(chunk);
                self.cursor += length;
            }
        }
        self.settle()
    }
    fn close(&mut self, complete: bool) -> Result<(), u32> {
        let backwards = self.ranges[self.phase].2;
        if !complete {
            if backwards && self.units.front().is_some_and(|v| low(*v)) {
                self.units.pop_front();
            }
            if !backwards && self.units.back().is_some_and(|v| high(*v)) {
                self.units.pop_back();
            }
        }
        let text = String::from_utf16(self.units.make_contiguous()).map_err(|_| 1u32)?;
        self.parts[[1, 0, 2][self.phase]] = text;
        if self.phase > 0 {
            self.edges[self.phase - 1] = complete;
        }
        self.units.clear();
        self.bytes = 0;
        self.phase += 1;
        if self.phase < 3 {
            self.cursor = self.ranges[self.phase].0;
        }
        Ok(())
    }
    fn settle(&mut self) -> Result<(), u32> {
        while self.phase < 3 && self.cursor == self.ranges[self.phase].1 {
            self.close(true)?;
        }
        Ok(())
    }
    /// Private source: shared combined redaction must still run before publication.
    pub fn finish(&self) -> Result<Vec<u8>, u32> {
        if self.failed || self.phase != 3 {
            return Err(1);
        }
        if self.projected {
            let parts = crate::source_window::field_parts(
                &self.parts,
                self.edges[0],
                self.edges[1] && self.complete,
            )?;
            return serde_json::to_vec(&json!({"parts":parts,"complete":self.complete}))
                .map_err(|_| 3);
        }
        if let Some([start_known, end_known]) = self.field_edges {
            let text = &self.parts[1];
            let range = crate::source_window::recognition_range_with_limit(
                text,
                start_known,
                end_known && self.complete,
                self.source_limit,
            )?;
            return serde_json::to_vec(&json!({"text": &text[range], "complete": self.complete}))
                .map_err(|_| 3);
        }
        if self.unavailable {
            return serde_json::to_vec(
                &json!({"parts":["","[redacted]",""],"selectionUnavailable":true}),
            )
            .map_err(|_| 3);
        }
        let mut window =
            json!({"parts":self.parts,"startKnown":self.edges[0],"endKnown":self.edges[1]});
        if let Some(starts) = &self.caret_starts {
            window["caretStarts"] = starts.clone();
        }
        if self.paragraph_starts.is_some() {
            window["paragraphStarts"] = json!(self.paragraph_bytes());
            window["caretEndsLine"] = json!(self.caret_ends_line);
        }
        let request = serde_json::to_vec(&json!({ "caretWindow": window })).map_err(|_| 3u32)?;
        crate::context::process(&request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A caret source over `text` (UTF-16 or scalar offsets) with the caret at `caret`, told
    /// `starts`; the finished window's parts.
    fn read_with_starts(
        text: &str,
        caret: usize,
        starts: &[usize],
        scalar: bool,
        ends_line: bool,
    ) -> serde_json::Value {
        let units: Vec<u16> = text.encode_utf16().collect();
        let scalars: Vec<char> = text.chars().collect();
        let count = if scalar { scalars.len() } else { units.len() };
        let mut source = if scalar {
            Source::new_scalar(count, caret, caret)
        } else {
            Source::new(count, caret, caret)
        }
        .unwrap();
        source.set_paragraph_starts(starts, ends_line).unwrap();
        while let Some((at, length)) = source.next().unwrap() {
            if scalar {
                source
                    .offer_utf8(&scalars[at..at + length].iter().collect::<String>())
                    .unwrap();
            } else {
                source.offer(&units[at..at + length]).unwrap();
            }
        }
        let reply: serde_json::Value = serde_json::from_slice(&source.finish().unwrap()).unwrap();
        reply["parts"].clone()
    }
    /// Paragraph starts are the provider's offsets: UTF-16 units (a start inside a surrogate pair
    /// is no start) or Unicode scalars. One at the read's first character, or past its end, has
    /// no break put back; one at the caret puts it before the caret.
    #[test]
    fn paragraph_starts_map_from_provider_offsets_into_the_parts() {
        assert_eq!(
            read_with_starts("Ab😀cd", 6, &[0, 1, 3, 4, 6, 9], false, false),
            json!(["A\u{2029}b😀\u{2029}cd\u{2029}", "", ""])
        );
        assert_eq!(
            read_with_starts("Ab😀cdef", 4, &[0, 3, 5], true, false),
            json!(["Ab😀\u{2029}c", "", "d\u{2029}ef"])
        );
        assert_eq!(
            read_with_starts("Ab\ncd", 3, &[3], false, false),
            json!(["Ab\n", "", "cd"])
        );
        // The caret ends the line above the paragraph starting at its offset: the break follows it.
        assert_eq!(
            read_with_starts("Abcd", 2, &[2], false, true),
            json!(["Ab", "", "\u{2029}cd"])
        );
        assert_eq!(
            read_with_starts("Abcd", 2, &[2], false, false),
            json!(["Ab\u{2029}", "", "cd"])
        );
    }
    #[test]
    fn paragraph_starts_are_a_caret_sources_once_and_ascending() {
        let mut source = Source::new(4, 2, 2).unwrap();
        assert_eq!(source.set_paragraph_starts(&[2, 1], false), Err(1));
        assert_eq!(source.set_paragraph_starts(&[1, 1], false), Err(1));
        assert_eq!(source.set_paragraph_starts(&[1, 2], false), Ok(()));
        assert_eq!(source.set_paragraph_starts(&[1, 2], false), Err(1));
        assert_eq!(source.set_caret_starts(json!({"paragraph":true})), Err(1));
        let mut caret = Source::new(4, 2, 2).unwrap();
        assert_eq!(caret.set_caret_starts(json!({"paragraph":true})), Ok(()));
        assert_eq!(caret.set_paragraph_starts(&[1], false), Err(1));
        let mut field = Source::field(4, 0, 4).unwrap();
        assert_eq!(field.set_paragraph_starts(&[1], false), Err(1));
        let mut many = Source::new(4, 2, 2).unwrap();
        let starts: Vec<usize> = (0..=PARAGRAPH_STARTS).collect();
        assert_eq!(many.set_paragraph_starts(&starts, false), Err(1));
        assert_eq!(
            many.set_paragraph_starts(&starts[..PARAGRAPH_STARTS], false),
            Ok(())
        );
    }
    #[test]
    fn block_sources_preserve_the_final_screen_fragment_before_budget_stop() {
        for text in [
            "x".repeat(300_000),
            format!("Visible. password: {}", "x".repeat(600_000)),
        ] {
            let mut source = Source::block_scalar(text.len(), 0, text.len()).unwrap();
            while let Some((at, length)) = source.next().unwrap() {
                source.offer_utf8(&text[at..at + length]).unwrap();
            }
            let result: serde_json::Value =
                serde_json::from_slice(&source.finish().unwrap()).unwrap();
            if text.len() == 300_000 {
                assert_eq!(result["text"], text);
                assert_eq!(result["complete"], true);
                let admission: serde_json::Value = serde_json::from_slice(
                    &crate::context::process(
                        &serde_json::to_vec(&json!({"admit":result["text"],"used":0})).unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap();
                assert_eq!(admission["budgetFull"], true);
            } else {
                assert_eq!(result["complete"], false);
                assert_eq!(result["text"], "Visible. ");
            }
        }
    }
    fn read_scalar(text: &str, start: usize, end: usize) -> serde_json::Value {
        let offsets: Vec<_> = text
            .char_indices()
            .map(|(at, _)| at)
            .chain([text.len()])
            .collect();
        let mut state = Source::new_scalar(offsets.len() - 1, start, end).unwrap();
        while let Some((at, length)) = state.next().unwrap() {
            assert!(length <= CHUNK_UNITS);
            state
                .offer_utf8(&text[offsets[at]..offsets[at + length]])
                .unwrap();
        }
        serde_json::from_slice(&state.finish().unwrap()).unwrap()
    }
    fn read(text: &str, start: usize, end: usize) -> serde_json::Value {
        let units: Vec<_> = text.encode_utf16().collect();
        let mut state = Source::new(units.len(), start, end).unwrap();
        while let Some((at, length)) = state.next().unwrap() {
            assert!(length <= CHUNK_UNITS);
            state.offer(&units[at..at + length]).unwrap();
        }
        serde_json::from_slice(&state.finish().unwrap()).unwrap()
    }
    #[test]
    fn complete_selection_at_exact_utf8_budget_keeps_split_surrogates() {
        let text = format!("a{}x", "😀".repeat(65534));
        assert_eq!(text.len(), crate::context::SELECTION_SOURCE_BYTES);
        let result = read(&text, 0, text.encode_utf16().count());
        assert_eq!(result["parts"], json!(["", text, ""]));
        assert_eq!(result["selectionUnavailable"], false);
    }
    #[test]
    fn oversized_selection_is_unavailable_not_a_prefix() {
        let text = "😀".repeat(65535);
        let result = read(&text, 0, text.encode_utf16().count());
        assert_eq!(result["parts"], json!(["", "[redacted]", ""]));
        assert_eq!(result["selectionUnavailable"], true);
    }
    #[test]
    fn long_field_preserves_selection_and_maps_open_edges() {
        let before = format!("{}. Before ", "a".repeat(300000));
        let selected = "s".repeat(20001);
        let text = format!("{before}{selected} after! {}", "b".repeat(300000));
        let result = read(&text, before.len(), before.len() + selected.len());
        assert_eq!(result["parts"][1], selected);
        assert_eq!(result["selectionUnavailable"], false);
        assert!(result["parts"][0].as_str().unwrap().len() < before.len());
    }
    #[test]
    fn short_provider_response_poisoning_prevents_partial_success() {
        let mut state = Source::new(10, 0, 10).unwrap();
        assert!(state.finish().is_err());
        assert!(state.offer(&[65; 9]).is_err());
        assert!(state.next().is_err());
        assert!(state.finish().is_err());
    }
    #[test]
    fn malformed_utf16_and_invalid_offsets_are_refused() {
        assert!(Source::new(1, 0, 2).is_err());
        let mut state = Source::new(1, 0, 1).unwrap();
        assert!(state.offer(&[0xd800]).is_err());
        assert!(state.finish().is_err());
    }
    #[test]
    fn scalar_and_utf16_offsets_preserve_the_same_unicode_selection() {
        let before = "Before 😀 e\u{301}. ";
        let selected = format!("a{}x", "😀".repeat(65534));
        let text = format!("{before}{selected} after 日本語.");
        let scalar = read_scalar(
            &text,
            before.chars().count(),
            before.chars().count() + selected.chars().count(),
        );
        let utf16 = read(
            &text,
            before.encode_utf16().count(),
            before.encode_utf16().count() + selected.encode_utf16().count(),
        );
        assert_eq!(scalar, utf16);
        assert_eq!(scalar["parts"][1], selected);
        assert_eq!(scalar["selectionUnavailable"], false);
    }
    #[test]
    fn scalar_selection_uses_utf8_bytes_not_character_count() {
        let text = "😀".repeat(65535);
        let result = read_scalar(&text, 0, text.chars().count());
        assert_eq!(result["parts"], json!(["", "[redacted]", ""]));
        assert_eq!(result["selectionUnavailable"], true);
    }
    #[test]
    fn scalar_long_field_uses_the_same_open_edge_policy() {
        let before = format!("{}. Before ", "😀".repeat(80000));
        let selected = "s".repeat(20001);
        let text = format!("{before}{selected} after! {}", "日".repeat(100000));
        let scalar = read_scalar(
            &text,
            before.chars().count(),
            before.chars().count() + selected.len(),
        );
        let utf16 = read(
            &text,
            before.encode_utf16().count(),
            before.encode_utf16().count() + selected.len(),
        );
        assert_eq!(scalar, utf16);
        assert_eq!(scalar["parts"][1], selected);
    }
    #[test]
    fn wrong_native_unit_and_short_scalar_offers_poison_the_owner() {
        let mut scalar = Source::new_scalar(2, 0, 2).unwrap();
        assert!(scalar.offer_utf8("😀").is_err());
        assert!(scalar.next().is_err());
        assert!(scalar.finish().is_err());
        let mut scalar = Source::new_scalar(1, 0, 1).unwrap();
        assert!(scalar.offer(&[65]).is_err());
        assert!(scalar.finish().is_err());
        let mut utf16 = Source::new(1, 0, 1).unwrap();
        assert!(utf16.offer_utf8("A").is_err());
        assert!(utf16.finish().is_err());
    }
    fn field(text: &str, start: usize, end: usize, scalar: bool) -> serde_json::Value {
        let offsets: Vec<_> = text
            .char_indices()
            .map(|(at, _)| at)
            .chain([text.len()])
            .collect();
        let units: Vec<_> = text.encode_utf16().collect();
        let mut state = if scalar {
            Source::field_scalar(offsets.len() - 1, start, end)
        } else {
            Source::field(units.len(), start, end)
        }
        .unwrap();
        while let Some((at, length)) = state.next().unwrap() {
            assert!(at >= start && at + length <= end && length <= CHUNK_UNITS);
            if scalar {
                state
                    .offer_utf8(&text[offsets[at]..offsets[at + length]])
                    .unwrap();
            } else {
                state.offer(&units[at..at + length]).unwrap();
            }
        }
        serde_json::from_slice(&state.finish().unwrap()).unwrap()
    }
    #[test]
    fn field_complete_unicode_and_empty_sources_are_preserved() {
        let text = "Before 😀 e\u{301} 日本語.";
        let scalar = field(text, 0, text.chars().count(), true);
        assert_eq!(scalar, field(text, 0, text.encode_utf16().count(), false));
        assert_eq!(scalar, json!({"text":text,"complete":true}));
        assert_eq!(field("", 0, 0, true), json!({"text":"","complete":true}));
    }
    #[test]
    fn field_visible_interval_does_not_read_outside_it_or_expose_open_tokens() {
        let text = "prefix unknown123. Visible sentence! unfinished456 suffix";
        let end = text.len() - " suffix".len();
        for scalar in [false, true] {
            assert_eq!(
                field(text, 7, end, scalar),
                json!({"text":". Visible sentence! ","complete":true})
            );
        }
    }
    #[test]
    fn field_byte_overflow_reports_incomplete_and_withholds_open_tail() {
        let text = format!("Visible! {}", "😀".repeat(80000));
        for scalar in [false, true] {
            let end = if scalar {
                text.chars().count()
            } else {
                text.encode_utf16().count()
            };
            let result = field(&text, 0, end, scalar);
            assert_eq!(result, json!({"text":"Visible! ","complete":false}));
        }
    }
    #[test]
    fn field_has_its_own_source_allowance_not_the_selection_allowance() {
        let text = "x".repeat(crate::context::SOURCE_WINDOW_BYTES);
        assert_eq!(
            field(&text, 0, text.len(), true),
            json!({"text":text,"complete":true})
        );
    }
    #[test]
    fn visible_field_retains_adjacent_recognition_source_and_target_mapping() {
        let text = "Offscreen. password: syntheticSecret123. Footer";
        let start = "Offscreen. password: ".len();
        let end = start + "syntheticSecret123".len();
        let mut state = Source::visible_field_scalar(text.len(), start, end).unwrap();
        while let Some((at, length)) = state.next().unwrap() {
            state.offer_utf8(&text[at..at + length]).unwrap();
        }
        let result: serde_json::Value = serde_json::from_slice(&state.finish().unwrap()).unwrap();
        assert_eq!(
            result,
            json!({"parts":[&text[..start],&text[start..end],&text[end..]],"complete":true})
        );
    }
    #[test]
    fn oversized_visible_target_does_not_join_source_across_omitted_tail() {
        let text = format!("Before. Visible! {}. unrelated suffix", "x".repeat(300000));
        let start = "Before. ".len();
        let end = text.len() - ". unrelated suffix".len();
        let mut state = Source::visible_field_scalar(text.len(), start, end).unwrap();
        while let Some((at, length)) = state.next().unwrap() {
            assert!(
                at + length <= end,
                "must not read after a target acquisition gap"
            );
            state.offer_utf8(&text[at..at + length]).unwrap();
        }
        let result: serde_json::Value = serde_json::from_slice(&state.finish().unwrap()).unwrap();
        assert_eq!(result["complete"], false);
        assert_eq!(result["parts"], json!(["Before. ", "Visible! ", ""]));
    }
}
