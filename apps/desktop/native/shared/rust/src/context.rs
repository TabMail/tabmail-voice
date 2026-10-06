// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::privacy;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone)]
struct Block {
    kind: String,
    text: String,
    frame: Option<[f64; 4]>,
    source: Option<Vec<String>>,
    runs: Option<Vec<(String, bool)>>,
}
impl Block {
    fn read(value: &Value) -> Result<Self, u32> {
        let kind = value["kind"].as_str().ok_or(1u32)?;
        if !["text", "heading", "link", "row", "field", "caret"].contains(&kind) {
            return Err(1);
        }
        let text = value["text"].as_str().ok_or(1u32)?.to_owned();
        let source = value.get("source").map(read_field).transpose()?;
        if source
            .as_ref()
            .is_some_and(|parts| kind != "field" || parts[1] != text)
        {
            return Err(1);
        }
        let runs = value.get("runs").map(read_runs).transpose()?;
        if let Some(runs) = &runs
            && (source.is_some()
                || !matches!(kind, "row" | "heading" | "link")
                || runs
                    .iter()
                    .filter(|(_, visible)| *visible)
                    .map(|(text, _)| text.as_str())
                    .collect::<String>()
                    != text)
        {
            return Err(1);
        }
        let frame = if value["frame"].is_null() {
            None
        } else {
            let array = value["frame"].as_array().ok_or(1u32)?;
            if array.len() != 4 {
                return Err(1);
            }
            let mut frame = [0.; 4];
            for (index, coordinate) in array.iter().enumerate() {
                frame[index] = coordinate.as_f64().filter(|x| x.is_finite()).ok_or(1u32)?;
            }
            Some(frame)
        };
        Ok(Self {
            kind: kind.into(),
            text,
            frame,
            source,
            runs,
        })
    }
    fn source_bytes(&self) -> usize {
        if let Some(runs) = &self.runs {
            runs.iter().map(|(text, _)| text.len()).sum()
        } else {
            self.source
                .as_ref()
                .map_or(self.text.len(), |parts| parts.iter().map(String::len).sum())
        }
    }
    fn json(&self) -> Value {
        json!({"kind":self.kind,"text":self.text,"frame":self.frame})
    }
    fn inline(&self) -> bool {
        self.kind == "text" || self.kind == "link"
    }
}
fn separator(a: &Block, b: &Block) -> &'static str {
    let (Some(a_frame), Some(b_frame)) = (a.frame, b.frame) else {
        return "\n";
    };
    let [ax, ay, aw, ah] = a_frame;
    let [bx, by, bw, bh] = b_frame;
    if aw <= 0. || ah <= 0. || bw <= 0. || bh <= 0. {
        return "\n";
    }
    let overlap = (ay + ah).min(by + bh) - ay.max(by);
    if a.inline() && b.inline() && bx >= ax && overlap >= ah.min(bh) * 0.5 {
        return " ";
    }
    if by + bh <= ay { "\n\n" } else { "\n" }
}
fn render(blocks: &[Block]) -> String {
    let mut result = String::new();
    for (index, block) in blocks.iter().enumerate() {
        if index > 0 {
            result.push_str(separator(&blocks[index - 1], block));
        }
        match block.kind.as_str() {
            "heading" => {
                result.push_str("## ");
                result.push_str(&block.text);
            }
            "link" => {
                result.push('[');
                result.push_str(&block.text);
                result.push(']');
            }
            "row" => {
                result.push_str("| ");
                result.push_str(&block.text);
            }
            "field" | "caret" => {
                let prefix = if block.kind == "field" { "> " } else { "» " };
                for (line_index, line) in block.text.split('\n').enumerate() {
                    if line_index > 0 {
                        result.push('\n');
                    }
                    result.push_str(prefix);
                    result.push_str(line);
                }
            }
            _ => result.push_str(&block.text),
        }
    }
    result
}

// Foundation's whitespace-and-newline set additionally includes zero-width space.
// Keep the Mac reference behavior for all platforms.
pub(crate) fn whitespace(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{200b}'
}

const SCREEN_BYTES: usize = crate::semantic::MAX_BYTES;
/// What stands in the screen read for a part withheld for privacy, on every platform.
const HIDDEN_MARKER: &str = "[hidden for privacy]";
pub(crate) const BLOCK_SOURCE_BYTES: usize = 2 * SCREEN_BYTES + 3;
const FIELD_SOURCE_BYTES: usize = 3 * SOURCE_WINDOW_BYTES;
pub(crate) const SEMANTIC_SOURCE_BYTES: usize = SCREEN_BYTES + FIELD_SOURCE_BYTES + 3;
const ALL_BLOCK_SOURCE_BYTES: usize = SCREEN_BYTES + SEMANTIC_SOURCE_BYTES;
fn read_runs(value: &Value) -> Result<Vec<(String, bool)>, u32> {
    let input = value
        .as_array()
        .filter(|v| v.len() <= crate::semantic::MAX_RUNS)
        .ok_or(1u32)?;
    let mut bytes = 0;
    input
        .iter()
        .map(|run| {
            let pair = run.as_array().filter(|v| v.len() == 2).ok_or(1u32)?;
            let text = pair[0]
                .as_str()
                .filter(|s| s.len() <= SOURCE_WINDOW_BYTES)
                .ok_or(1u32)?;
            let visible = pair[1].as_bool().ok_or(1u32)?;
            bytes += text.len();
            if bytes > SEMANTIC_SOURCE_BYTES {
                return Err(1);
            }
            Ok((text.to_owned(), visible))
        })
        .collect()
}
fn read_field(value: &Value) -> Result<Vec<String>, u32> {
    let parts = value.as_array().filter(|a| a.len() == 3).ok_or(1u32)?;
    parts
        .iter()
        .map(|part| {
            part.as_str()
                .filter(|s| s.len() <= SOURCE_WINDOW_BYTES)
                .map(str::to_owned)
                .ok_or(1)
        })
        .collect()
}
pub(crate) const SOURCE_WINDOW_BYTES: usize = crate::semantic::MAX_BYTES;
pub(crate) const SELECTION_SOURCE_BYTES: usize = SCREEN_BYTES - 6;
const CARET_SOURCE_BYTES: usize = SELECTION_SOURCE_BYTES + 2 * SOURCE_WINDOW_BYTES;
// How much of the line at a caret an adapter reads to tell an empty line (a break) from words;
// a longer line is sent as `null`.
const CARET_LINE_BYTES: usize = 3;
const CARET_SIDE_GRAPHEMES: usize = 2_000;

fn caret_text(parts: &[String]) -> String {
    format!(
        "{}‸{}{}{}",
        parts[0],
        parts[1],
        if parts[1].is_empty() { "" } else { "‸" },
        parts[2]
    )
}
fn read_caret(value: &Value) -> Result<Vec<String>, u32> {
    let parts: Vec<String> = serde_json::from_value(value.clone()).map_err(|_| 1u32)?;
    if parts.len() != 3
        || parts[0].len() > SOURCE_WINDOW_BYTES
        || parts[1].len() > SELECTION_SOURCE_BYTES
        || parts[2].len() > SOURCE_WINDOW_BYTES
    {
        return Err(1);
    }
    Ok(parts)
}
fn prefix_end(text: &str, graphemes: usize, bytes: usize) -> usize {
    let mut end = 0;
    for (index, (start, part)) in text.grapheme_indices(true).enumerate() {
        if index >= graphemes || start + part.len() > bytes {
            break;
        }
        end = start + part.len();
    }
    end
}
fn suffix_start(text: &str, graphemes: usize, bytes: usize) -> usize {
    let mut start = text.len();
    for (index, (offset, _)) in text.grapheme_indices(true).rev().enumerate() {
        if index >= graphemes || text.len() - offset > bytes {
            break;
        }
        start = offset;
    }
    start
}
fn present_caret(parts: &mut [String]) -> Result<bool, u32> {
    let selection_bytes = parts[1].len() + if parts[1].is_empty() { 3 } else { 6 };
    if selection_bytes > SCREEN_BYTES {
        return Err(3);
    }
    let remaining = SCREEN_BYTES - selection_bytes;
    let before_start = suffix_start(&parts[0], CARET_SIDE_GRAPHEMES, remaining / 2);
    let after_end = prefix_end(
        &parts[2],
        CARET_SIDE_GRAPHEMES,
        remaining - (parts[0].len() - before_start),
    );
    // Reuse any allowance the after-side did not need, keeping nearest context.
    let before_start = suffix_start(&parts[0], CARET_SIDE_GRAPHEMES, remaining - after_end);
    let changed = before_start != 0 || after_end != parts[2].len();
    parts[0] = parts[0][before_start..].to_owned();
    parts[2].truncate(after_end);
    Ok(changed)
}
fn present_blocks(blocks: &mut Vec<Block>, reserved: usize) -> Result<bool, u32> {
    if reserved > SCREEN_BYTES {
        return Err(3);
    }
    let mut remaining = SCREEN_BYTES - reserved;
    let mut changed = false;
    for block in blocks.iter_mut().filter(|b| b.kind != "caret") {
        let graphemes = if matches!(block.kind.as_str(), "row" | "heading" | "link") {
            crate::semantic::MAX_GRAPHEMES
        } else {
            usize::MAX
        };
        let mut end = prefix_end(&block.text, graphemes, remaining);
        if end < block.text.len() && block.kind == "row" {
            // Row text treats ` | ` as a column separator. A prefix must not
            // finish inside that separator, or just after it with no next cell.
            for back in 1..=3 {
                if let Some(start) = end.checked_sub(back)
                    && block.text.as_bytes().get(start..start + 3) == Some(b" | ")
                {
                    end = start;
                    break;
                }
            }
        }
        changed |= end < block.text.len();
        block.text.truncate(end);
        remaining -= end;
    }
    blocks.retain(|b| b.kind == "caret" || !b.text.is_empty());
    Ok(changed)
}

/// Inputs have already passed the native provider's pre-read privacy checks.
/// With caret supplied, redact the combined screen before adding layout markers.
pub fn process(input: &[u8]) -> Result<Vec<u8>, u32> {
    let request: Value = serde_json::from_slice(input).map_err(|_| 1u32)?;
    if let Some(window) = request.get("blockWindow") {
        let text = window["text"].as_str().ok_or(1u32)?;
        let start = window["startKnown"].as_bool().ok_or(1u32)?;
        let end = window["endKnown"].as_bool().ok_or(1u32)?;
        let retained = crate::source_window::recognition_range_with_limit(
            text,
            start,
            end,
            BLOCK_SOURCE_BYTES,
        )?;
        return serde_json::to_vec(&json!({"text":&text[retained]})).map_err(|_| 3);
    }
    if let Some(window) = request.get("fieldWindow") {
        let parts = read_field(&window["parts"])?;
        let start = window["startKnown"].as_bool().ok_or(1u32)?;
        let end = window["endKnown"].as_bool().ok_or(1u32)?;
        return serde_json::to_vec(
            &json!({"parts":crate::source_window::field_parts(&parts, start, end)?}),
        )
        .map_err(|_| 3);
    }
    if request.get("opaqueProbes") == Some(&Value::Bool(true)) {
        let mut amount = match request.get("scope").and_then(Value::as_str) {
            None if request.get("scope").is_none() => SOURCE_WINDOW_BYTES,
            Some("field") => SOURCE_WINDOW_BYTES,
            Some("block") => BLOCK_SOURCE_BYTES,
            _ => return Err(1),
        };
        let mut probes = Vec::new();
        while amount > 0 {
            probes.push(amount);
            amount /= 2;
        }
        return serde_json::to_vec(&json!({"amounts":probes})).map_err(|_| 3);
    }
    // A rich editor's text, from the parts a helper read in order (ADR-DESK-007, 2026-10-06): AT-SPI
    // gives each paragraph or link of a Chromium contenteditable as an embedded object with text of
    // its own, so the helper sends each element's own text, where its caret and its part of the
    // selection are, and where a block element starts and ends. A block starts a line of its own,
    // and text after one starts a new line; the caret is the first reported, the selection runs from
    // the first part's start to the last part's end. Offsets count Unicode scalars, as AT-SPI does.
    if let Some(hypertext) = request.get("hypertext") {
        let parts = hypertext["parts"].as_array().ok_or(1u32)?;
        let mut text = String::new();
        let mut length = 0usize;
        let mut after_block = false;
        let mut caret = None;
        let mut selection: Option<(usize, usize)> = None;
        let break_line = |text: &mut String, length: &mut usize| {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
                *length += 1;
            }
        };
        for part in parts {
            if let Some(run) = part.get("text") {
                let run = run.as_str().ok_or(1u32)?;
                if after_block && !run.is_empty() {
                    break_line(&mut text, &mut length);
                    after_block = false;
                }
                text.push_str(run);
                length += run.chars().count();
                if text.len() > CARET_SOURCE_BYTES {
                    return Err(1);
                }
                continue;
            }
            match part.get("mark").and_then(Value::as_str).ok_or(1u32)? {
                "blockStart" => {
                    break_line(&mut text, &mut length);
                    after_block = false;
                }
                "blockEnd" => after_block = true,
                mark @ ("caret" | "selectionStart") => {
                    if after_block {
                        break_line(&mut text, &mut length);
                        after_block = false;
                    }
                    if mark == "caret" {
                        caret.get_or_insert(length);
                    } else if selection.is_none() {
                        selection = Some((length, length));
                    }
                }
                "selectionEnd" => match selection.as_mut() {
                    Some(range) => range.1 = length,
                    None => return Err(1),
                },
                _ => return Err(1),
            }
        }
        return serde_json::to_vec(&json!({
            "text": text,
            "length": length,
            "caret": caret,
            "selection": selection.map(|(start, end)| [start, end]),
        }))
        .map_err(|_| 3);
    }
    if let Some(window) = request.get("caretWindow") {
        let mut parts = read_caret(&window["parts"])?;
        let mut start_known = window["startKnown"].as_bool().ok_or(1u32)?;
        let end_known = window["endKnown"].as_bool().ok_or(1u32)?;
        // A caret that starts a paragraph or an empty line, whose break the text before it doesn't
        // show, gets the break: Chromium gives an empty line no character and leaves out some
        // paragraph breaks, so without it the text reads as if the caret followed the last word
        // (ADR-DESK-007, 2026-10-06). The adapter says what it measured (`caretStarts`, absent:
        // nothing, no break): whether a paragraph starts at the caret, whether a line does, and the
        // first few bytes of that line. A line holding only a break is an empty line (Chromium puts
        // its caret where the paragraph above ends); a soft-wrapped line holds words and gets none.
        // The break is counted in the before-part's budget: one at the limit gives up its first
        // character, and its start.
        let starts_paragraph = match window.get("caretStarts") {
            None => false,
            Some(starts) => {
                let paragraph = starts["paragraph"].as_bool().ok_or(1u32)?;
                let line = starts["line"].as_bool().ok_or(1u32)?;
                // `null`: the line holds more than `CARET_LINE_BYTES`, so words.
                let line_text = match starts.get("lineText").ok_or(1u32)? {
                    Value::Null => None,
                    text => Some(text.as_str().ok_or(1u32)?),
                };
                if line_text.is_some_and(|text| text.len() > CARET_LINE_BYTES) {
                    return Err(1);
                }
                let only_break = line_text.is_some_and(|text| {
                    matches!(text, "" | "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}")
                });
                paragraph || (line && only_break)
            }
        };
        let unbroken = parts[0]
            .chars()
            .last()
            .is_some_and(|last| !matches!(last, '\n' | '\r' | '\u{2028}' | '\u{2029}'));
        // The render, which redacts the whole screen, withholds the caret where the break may split a
        // secret.
        if starts_paragraph && unbroken {
            parts[0].push('\n');
            if parts[0].len() > SOURCE_WINDOW_BYTES {
                let first = parts[0].chars().next().map_or(0, char::len_utf8);
                parts[0].drain(..first);
                start_known = false;
            }
        }
        let text = parts.concat();
        let range = crate::source_window::recognition_range_with_limit(
            &text,
            start_known,
            end_known,
            CARET_SOURCE_BYTES,
        )?;
        let selected_start = parts[0].len();
        let selected_end = selected_start + parts[1].len();
        let caret_withheld = range.start > selected_start || range.end < selected_end;
        let unavailable = !parts[1].is_empty() && caret_withheld;
        // Replacing only the selected fragment would erase recognition context
        // for an adjacent side. Refuse the whole caret window in this case;
        // other independently approved screen blocks remain available.
        if caret_withheld {
            return serde_json::to_vec(
                &json!({"parts":["",if unavailable { privacy::PLACEHOLDER } else { "" },""],"selectionUnavailable":unavailable}),
            )
            .map_err(|_| 3);
        }
        let mut offset = 0;
        let retained: Vec<String> = parts
            .iter()
            .map(|part| {
                let end = offset + part.len();
                let from = offset.max(range.start);
                let to = end.min(range.end);
                offset = end;
                if from < to {
                    text[from..to].to_owned()
                } else {
                    String::new()
                }
            })
            .collect();
        return serde_json::to_vec(&json!({"parts":retained,"selectionUnavailable":unavailable}))
            .map_err(|_| 3);
    }
    if let Some(window) = request.get("window") {
        let text = window["text"].as_str().ok_or(1u32)?;
        let start_known = window["startKnown"].as_bool().ok_or(1u32)?;
        let end_known = window["endKnown"].as_bool().ok_or(1u32)?;
        let range = crate::source_window::recognition_range(text, start_known, end_known)?;
        return serde_json::to_vec(&json!({
            "sourceText": &text[range.clone()],
            "sourceStartByte": range.start,
            "sourceEndByte": range.end,
            "prefixWithheld": !start_known,
            "suffixWithheld": !end_known,
            "unavailable": !text.is_empty() && range.is_empty()
        }))
        .map_err(|_| 3);
    }
    if request.get("limits") == Some(&Value::Bool(true)) {
        return serde_json::to_vec(&json!({"screenBytes":SCREEN_BYTES,"blockSourceBytes":BLOCK_SOURCE_BYTES,"semanticGraphemes":crate::semantic::MAX_GRAPHEMES,"caretSideGraphemes":CARET_SIDE_GRAPHEMES,"sourceWindowBytes":SOURCE_WINDOW_BYTES,"selectionSourceBytes":SELECTION_SOURCE_BYTES,"caretSourceBytes":CARET_SOURCE_BYTES,"caretLineBytes":CARET_LINE_BYTES,"sourceChunkUnits":crate::source::CHUNK_UNITS,"fieldRangeCount":64,"hiddenMarker":HIDDEN_MARKER})).map_err(|_|3);
    }
    if let Some(value) = request.get("reserveCaret") {
        // This copy computes only the prospective presentation reservation.
        // Callers retain the complete source for combined redaction.
        let mut caret = read_caret(value)?;
        present_caret(&mut caret)?;
        let used = caret_text(&caret).len();
        return serde_json::to_vec(&json!({"used":used,"budgetFull":used >= SCREEN_BYTES}))
            .map_err(|_| 3);
    }
    if let Some(value) = request.get("fieldPlan") {
        if !value.is_object() {
            return Err(1);
        }
        let count = match value.get("count") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_u64().ok_or(1u32)?),
        };
        let whole = match value.get("text") {
            None | Some(Value::Null) => false,
            Some(v) => {
                let text = v.as_str().ok_or(1u32)?;
                text.len() <= SOURCE_WINDOW_BYTES
                    && text
                        .graphemes(true)
                        .take(crate::semantic::MAX_GRAPHEMES + 1)
                        .count()
                        <= crate::semantic::MAX_GRAPHEMES
            }
        };
        return serde_json::to_vec(&json!({"probeWhole":count.is_none_or(|n| n <= SOURCE_WINDOW_BYTES as u64),"useWhole":whole})).map_err(|_|3);
    }
    if let Some(value) = request.get("fieldRanges") {
        let count = value["count"].as_u64().ok_or(1u32)?;
        let input = value["ranges"]
            .as_array()
            .filter(|r| r.len() <= 64)
            .ok_or(1u32)?;
        let mut ranges = Vec::with_capacity(input.len());
        for range in input {
            let pair = range.as_array().filter(|r| r.len() == 2).ok_or(1u32)?;
            let start = pair[0].as_u64().ok_or(1u32)?;
            let end = pair[1].as_u64().ok_or(1u32)?;
            if start > end || end > count {
                return Err(1);
            }
            if start != end {
                ranges.push((start, end));
            }
        }
        ranges.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for (start, end) in ranges {
            if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
                last.1 = last.1.max(end);
            } else {
                merged.push((start, end));
            }
        }
        // Only overlapping/touching intervals coalesce. A hidden gap must never
        // become visible merely because two provider ranges surround it.
        return serde_json::to_vec(&json!({"ranges":merged})).map_err(|_| 3);
    }
    if let Some(value) = request.get("admitSemantic") {
        let mut block = Block::read(value)?;
        if block.runs.is_none() {
            return Err(1);
        }
        let used = request["used"]
            .as_u64()
            .filter(|n| *n <= ALL_BLOCK_SOURCE_BYTES as u64)
            .ok_or(1u32)? as usize;
        let duplicate = if let Some(previous) = request.get("previous").filter(|p| !p.is_null()) {
            let previous = Block::read(previous)?;
            previous.kind != "caret"
                && previous.text.nfd().eq(block.text.nfd())
                && (previous.runs == block.runs
                    || (previous.source.is_none()
                        && previous
                            .runs
                            .as_ref()
                            .is_none_or(|runs| runs.iter().all(|(_, shown)| *shown))
                        && block
                            .runs
                            .as_ref()
                            .is_some_and(|runs| runs.iter().all(|(_, shown)| *shown))))
        } else {
            false
        };
        if used >= SCREEN_BYTES || block.text.is_empty() || duplicate {
            block.text.clear();
            block.runs = Some(Vec::new());
        }
        let used = used + block.source_bytes();
        return serde_json::to_vec(&json!({"text":block.text,"runs":block.runs,"used":used,"budgetFull":used >= SCREEN_BYTES})).map_err(|_|3);
    }
    if let Some(value) = request.get("admitField") {
        let mut parts = read_field(value)?;
        let used = request["used"]
            .as_u64()
            .filter(|n| *n <= ALL_BLOCK_SOURCE_BYTES as u64)
            .ok_or(1u32)? as usize;
        // Do not trim/deduplicate private fragments before matching: whitespace
        // and offscreen prefixes can determine whether visible text is secret.
        if used >= SCREEN_BYTES || parts[1].is_empty() {
            parts = vec![String::new(); 3];
        }
        let used = used + parts.iter().map(String::len).sum::<usize>();
        return serde_json::to_vec(
            &json!({"parts":parts,"used":used,"budgetFull":used >= SCREEN_BYTES}),
        )
        .map_err(|_| 3);
    }
    if let Some(value) = request.get("admit") {
        let source = value
            .as_str()
            .filter(|s| s.len() <= BLOCK_SOURCE_BYTES)
            .ok_or(1u32)?;
        let used = request["used"]
            .as_u64()
            .filter(|n| *n <= ALL_BLOCK_SOURCE_BYTES as u64)
            .ok_or(1u32)? as usize;
        let previous = request.get("previous");
        if previous.is_some_and(|p| !p.is_null() && !p.is_string()) {
            return Err(1);
        }
        let text = source.trim_matches(whitespace);
        let text = if used >= SCREEN_BYTES
            || previous
                .and_then(Value::as_str)
                .is_some_and(|p| p.nfd().eq(text.nfd()))
        {
            ""
        } else {
            text
        };
        let used = used + text.len();
        return serde_json::to_vec(
            &json!({"text":text,"used":used,"budgetFull":used >= SCREEN_BYTES}),
        )
        .map_err(|_| 3);
    }
    if let Some(value) = request.get("normalize") {
        if request.get("limit").is_some() {
            return Err(1);
        }
        let text = value.as_str().ok_or(1u32)?.trim_matches(whitespace);
        if let Some(previous) = request.get("previous") {
            if !previous.is_null() && !previous.is_string() {
                return Err(1);
            }
            if previous
                .as_str()
                .is_some_and(|previous| previous.nfd().eq(text.nfd()))
            {
                return serde_json::to_vec(&json!({"text":"", "truncated":false}))
                    .map_err(|_| 3u32);
            }
        }
        return serde_json::to_vec(&json!({"text":text, "truncated":false})).map_err(|_| 3u32);
    }
    let mut blocks: Vec<Block> = request["blocks"]
        .as_array()
        .ok_or(1u32)?
        .iter()
        .map(Block::read)
        .collect::<Result<_, _>>()?;
    if blocks.len() > 5_000
        || blocks.iter().filter(|b| b.kind == "caret").count() > 1
        || blocks.iter().any(|b| b.text.len() > BLOCK_SOURCE_BYTES)
    {
        return Err(1);
    }
    let mut response = json!({});
    let mut truncated = false;
    let reserved;
    let empty_caret = json!(["", "", ""]);
    let projected = blocks
        .iter()
        .any(|b| b.source.is_some() || b.runs.is_some());
    if projected && request.get("caret").is_none() && blocks.iter().any(|b| b.kind == "caret") {
        return Err(1);
    }
    if let Some(caret_value) = request.get("caret").or(projected.then_some(&empty_caret)) {
        let caret = read_caret(caret_value)?;
        let block_source_bytes = blocks
            .iter()
            .filter(|b| b.kind != "caret")
            .map(Block::source_bytes)
            .sum::<usize>();
        // Recognition-only side context has its own finite allowance. It must
        // not displace ordinary visible blocks from the presentation budget.
        let source_bytes = block_source_bytes + caret_text(&caret).len();
        if block_source_bytes > ALL_BLOCK_SOURCE_BYTES
            || source_bytes > ALL_BLOCK_SOURCE_BYTES + 2 * SOURCE_WINDOW_BYTES
        {
            return Err(1);
        }
        let caret_index = blocks
            .iter()
            .position(|b| b.kind == "caret")
            .unwrap_or(blocks.len());
        let mut lines: privacy::Lines = blocks
            .iter()
            .map(|b| {
                if b.kind == "caret" {
                    caret.clone()
                } else if let Some(runs) = &b.runs {
                    runs.iter().map(|(text, _)| text.clone()).collect()
                } else {
                    b.source.clone().unwrap_or_else(|| vec![b.text.clone()])
                }
            })
            .collect();
        if caret_index == blocks.len() {
            lines.push(caret.clone());
        }
        // A break just before the caret is either the left-out one a caret window added or the
        // text's own, and neither text can be trusted alone where the caret, without the break, is
        // inside a match: an added break would split a secret the redactor has to see whole (a key
        // soft-wrapped at the caret, or one in a field under its label's block), and taking out the
        // text's own can join two keys into one match that hides the second's start. There the
        // caret's text is withheld, and the rest must read the same either way, or nothing is read
        // (ADR-DESK-007, 2026-10-06).
        let redacted = privacy::redact(&lines).map_err(|_| 3u32)?;
        let mut withheld = false;
        if caret[0].ends_with('\n') {
            let mut joined = lines.clone();
            joined[caret_index][0].pop();
            let anchor = joined[..caret_index]
                .iter()
                .map(|line| {
                    line.iter()
                        .map(|part| part.encode_utf16().count())
                        .sum::<usize>()
                        + 1
                })
                .sum::<usize>()
                + joined[caret_index][0].encode_utf16().count();
            let (without, anchors) =
                privacy::redact_anchored(&joined, &[anchor]).map_err(|_| 3u32)?;
            if anchors.first().is_none_or(Option::is_none) {
                let differs = (0..redacted.len())
                    .any(|index| index != caret_index && redacted[index] != without[index]);
                if differs {
                    return Err(3);
                }
                withheld = true;
            }
        }
        let mut around = if withheld {
            let selected = if caret[1].is_empty() {
                ""
            } else {
                privacy::PLACEHOLDER
            };
            vec![String::new(), selected.to_owned(), String::new()]
        } else {
            redacted[caret_index].clone()
        };
        let changed = around[1] != caret[1];
        if changed && around[1].trim_matches(whitespace).is_empty() {
            around[1] = privacy::PLACEHOLDER.into();
        }
        truncated |= present_caret(&mut around)?;
        let formatted_caret = caret_text(&around);
        reserved = formatted_caret.len();
        for (index, block) in blocks.iter_mut().enumerate() {
            block.text = if block.kind == "caret" {
                formatted_caret.clone()
            } else if let Some(runs) = &block.runs {
                runs.iter()
                    .zip(&redacted[index])
                    .filter(|((_, visible), _)| *visible)
                    .map(|((original, _), value)| {
                        if value != original
                            && value.trim_matches(whitespace).is_empty()
                            && !original.trim_matches(whitespace).is_empty()
                        {
                            privacy::PLACEHOLDER.to_owned()
                        } else {
                            value.clone()
                        }
                    })
                    .collect::<String>()
                    .trim_matches(whitespace)
                    .to_owned()
            } else if block.source.is_some() {
                let visible = &redacted[index][1];
                if visible != &block.text
                    && visible.trim_matches(whitespace).is_empty()
                    && !block.text.trim_matches(whitespace).is_empty()
                {
                    privacy::PLACEHOLDER.to_owned()
                } else {
                    visible.trim_matches(whitespace).to_owned()
                }
            } else {
                redacted[index][0].clone()
            };
            block.source = None;
            block.runs = None;
        }
        blocks.retain(|b| b.kind == "caret" || !b.text.is_empty());
        response["caret"] = json!(around);
        response["selectionRedacted"] = json!(changed);
    } else {
        if blocks.iter().map(|b| b.text.len()).sum::<usize>() > SCREEN_BYTES + BLOCK_SOURCE_BYTES {
            return Err(1);
        }
        reserved = blocks
            .iter()
            .filter(|b| b.kind == "caret")
            .map(|b| b.text.len())
            .sum();
    }
    truncated |= present_blocks(&mut blocks, reserved)?;
    response["truncated"] = json!(truncated);
    response["blocks"] = Value::Array(blocks.iter().map(Block::json).collect());
    response["rendered"] = json!(render(&blocks));
    serde_json::to_vec(&response).map_err(|_| 3u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layout_and_split_selection() {
        let response: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(&json!({
                    "blocks":[
                        {"kind":"text","text":"Author","frame":[0,0,40,20]},
                        {"kind":"link","text":"time","frame":[50,0,30,20]},
                        {"kind":"text","text":"password:"},
                        {"kind":"caret","text":"ignored","frame":[0,40,200,20]},
                        {"kind":"field","text":"line1\nline2","frame":[300,0,200,20]}],
                    "caret":["hunter","2x",""]
                }))
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            response["rendered"],
            "Author [time]\npassword:\n» [redacted]‸[redacted]‸\n\n> line1\n> line2"
        );
        assert_eq!(response["selectionRedacted"], true);
        assert_eq!(response["blocks"][3]["frame"], json!([0., 40., 200., 20.]));
    }
    #[test]
    fn invalid_shape_refuses() {
        for value in [
            json!({}),
            json!({"hypertext":{}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":1,"line":true,"lineText":""}}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":false,"line":true}}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":false,"line":true,"lineText":"abcd"}}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":false,"line":true,"lineText":7}}}),
            json!({"hypertext":{"parts":[{"text":1}]}}),
            json!({"hypertext":{"parts":[{"mark":"elsewhere"}]}}),
            json!({"hypertext":{"parts":[{}]}}),
            json!({"hypertext":{"parts":[{"mark":"selectionEnd"}]}}),
            json!({"hypertext":{"parts":[{"text":"x".repeat(CARET_SOURCE_BYTES + 1)}]}}),
            json!({"blocks":[{"kind":"unknown","text":"x"}]}),
            json!({"blocks":[],"caret":["x"]}),
        ] {
            assert_eq!(process(&serde_json::to_vec(&value).unwrap()), Err(1));
        }
    }
}

#[cfg(test)]
mod normalization_tests {
    use super::*;
    #[test]
    fn mac_whitespace_preserves_complete_source() {
        let call = |value: Value| -> Value {
            serde_json::from_slice(&process(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap()
        };
        assert_eq!(
            call(json!({"normalize":"\u{200b}\u{85} hello\u{a0}"}))["text"],
            "hello"
        );
        assert_eq!(
            call(json!({"normalize":"\u{feff}hello"}))["text"],
            "\u{feff}hello"
        );
        assert_eq!(
            call(json!({"normalize":"a🙂z"})),
            json!({"text":"a🙂z", "truncated":false})
        );
        assert_eq!(
            call(json!({"normalize":" hello ","previous":"hello"}))["text"],
            ""
        );
        assert_eq!(process(br#"{"normalize":5}"#), Err(1));
        assert_eq!(process(br#"{"normalize":"x","limit":-1}"#), Err(1));
    }
}

#[cfg(test)]
mod conformance {
    use super::*;
    #[test]
    fn shared_context_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../context/context-cases.json")).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() >= 11);
        for case in cases {
            let actual: Value = serde_json::from_slice(
                &process(&serde_json::to_vec(&case["request"]).unwrap()).unwrap(),
            )
            .unwrap();
            for (key, expected) in case["expected"].as_object().unwrap() {
                assert_eq!(&actual[key], expected, "{}: {key}", case["name"]);
            }
        }
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    const SCREEN: usize = 256 * 1024;
    fn call(value: Value) -> Value {
        serde_json::from_slice(&process(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap()
    }
    #[test]
    fn caret_window_keeps_complete_selection_and_maps_unicode_source_edges() {
        let reply = call(
            json!({"caretWindow":{"parts":["unknown😀. Before ","選択"," after! unfinished"],"startKnown":false,"endKnown":false}}),
        );
        assert_eq!(reply["parts"], json!([". Before ", "選択", " after! "]));
        assert_eq!(reply["selectionUnavailable"], false);
    }
    #[test]
    fn a_left_out_break_is_counted_in_the_before_parts_budget() {
        let before = "Why does it move. ".repeat(SOURCE_WINDOW_BYTES / 18 + 1)
            [..SOURCE_WINDOW_BYTES - 1]
            .to_owned()
            + "x";
        assert_eq!(before.len(), SOURCE_WINDOW_BYTES);
        let reply = call(
            json!({"caretWindow":{"parts":[before,"",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":"Wh"}}}),
        );
        let kept = reply["parts"][0].as_str().unwrap();
        assert!(kept.ends_with("x\n") && kept.len() <= SOURCE_WINDOW_BYTES && !kept.is_empty());
        assert_eq!(reply["selectionUnavailable"], false);
    }
    /// The break at the limit costs the before-part its first character, so its start is no longer
    /// known: a key there, its prefix cut off, must not reach the reply as plain text. The rest is
    /// a few large graphemes, so all of it is shown.
    #[test]
    fn a_key_whose_prefix_the_break_cuts_off_is_not_shown() {
        let head = concat!("sk", "-", "A1b2C3d4E5f6G7h8I9j0K1. ");
        let mark = format!("a{}", "\u{301}".repeat(99));
        let mut before =
            head.to_owned() + &mark.repeat((SOURCE_WINDOW_BYTES - head.len()) / mark.len());
        before += &"b".repeat(SOURCE_WINDOW_BYTES - before.len());
        assert_eq!(before.len(), SOURCE_WINDOW_BYTES);
        let window = call(
            json!({"caretWindow":{"parts":[before,""," after"],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":null}}}),
        );
        let reply = call(json!({"blocks":[],"caret":window["parts"]}));
        assert!(reply["caret"][0].as_str().unwrap().ends_with("bbb\n"));
        assert!(!reply.to_string().contains("G7h8I9j0"));
    }
    /// A key soft-wrapped at a caret said to start a paragraph never reaches the reply in halves:
    /// without the break the caret is inside it, so the caret's text is withheld.
    #[test]
    fn a_secret_wrapped_at_the_caret_is_redacted_whole() {
        let (head, tail) = (concat!("Key gh", "p_0123456789"), "abcdefghijKLMNOP rest");
        let window = call(
            json!({"caretWindow":{"parts":[head,"",tail],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":null}}}),
        );
        let reply = call(json!({"blocks":[],"caret":window["parts"]}));
        let text = reply.to_string();
        assert!(
            !text.contains("0123456789") && !text.contains("abcdefghij"),
            "{text}"
        );
        assert_eq!(reply["caret"], json!(["", "", ""]));
    }
    /// A key in a field under its label's block, with the caret said to start a paragraph inside
    /// it: the caret's own text holds no secret, so only the whole screen shows that the break
    /// would split one, and the render withholds the caret's text.
    #[test]
    fn a_secret_under_its_label_block_is_not_split_by_the_break() {
        let window = call(
            json!({"caretWindow":{"parts":["a","","1B2c3D4e5F6g7H8i9J0k1L2 thanks"],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":false,"lineText":null}}}),
        );
        let reply = call(
            json!({"blocks":[{"kind":"text","text":"Authorization: Bearer"},{"kind":"caret","text":"ignored"}],"caret":window["parts"]}),
        );
        let text = reply.to_string();
        assert!(!text.contains("1B2c3D4"), "{text}");
        assert_eq!(reply["caret"], json!(["", "", ""]));
        assert!(text.contains("Authorization: Bearer"), "{text}");
    }
    /// Two keys on lines of their own, the caret at the second's start, whether the break between
    /// them is the text's own or one the caret window added: joined, the first key's match would
    /// take the second's prefix, and split, an added break would cut a key the text holds whole.
    /// Neither key reaches the reply, whole or in part.
    #[test]
    fn two_keys_at_a_break_are_never_shown_in_part() {
        let (first, second) = (
            concat!("gh", "p_AAAAAAAAAAAAAAAAAAAA"),
            concat!("gh", "p_0123456789abcdefXYZW"),
        );
        let added = call(
            json!({"caretWindow":{"parts":[first,"",second],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":null}}}),
        );
        for caret in [
            json!([format!("{first}\n"), "", second]),
            added["parts"].clone(),
        ] {
            let text =
                call(json!({"blocks":[{"kind":"text","text":"Keys"}],"caret":caret})).to_string();
            assert!(
                !text.contains("AAAAAAAAAAAA") && !text.contains("0123456789abcdef"),
                "{text}"
            );
            assert!(text.contains("Keys"), "{text}");
        }
    }
    /// The caret's place in the screen the redactor sees counts the blocks above it in UTF-16
    /// units, as the redactor does: text above it outside ASCII must not move it off the key.
    #[test]
    fn a_key_split_at_the_caret_below_wide_text_is_still_withheld() {
        let window = call(
            json!({"caretWindow":{"parts":[concat!("Key gh", "p_0123456789"),"","abcdef rest"],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":null}}}),
        );
        let reply = call(
            json!({"blocks":[{"kind":"text","text":"Notes ☕☕☕☕"},{"kind":"caret","text":"ignored"}],"caret":window["parts"]}),
        );
        let text = reply.to_string();
        assert!(
            !text.contains("0123456789") && !text.contains("abcdef"),
            "{text}"
        );
        assert_eq!(reply["caret"], json!(["", "", ""]));
    }
    /// Key lines whose last line the caret starts a paragraph inside: joined, the block above is a
    /// key line too and is redacted, split, it is not. A block that reads differently either way
    /// can't be shown, so nothing is.
    #[test]
    fn a_block_the_break_decides_the_redaction_of_refuses_the_read() {
        let line = "QUJD".repeat(16);
        let caret = json!([format!("{}\n", &line[..30]), "", &line[30..60]]);
        let request = json!({"blocks":[{"kind":"text","text":line},{"kind":"caret","text":"ignored"}],"caret":caret});
        assert_eq!(process(&serde_json::to_vec(&request).unwrap()), Err(3));
    }
    #[test]
    fn caret_window_never_returns_a_partial_selection_at_an_open_edge() {
        let reply = call(
            json!({"caretWindow":{"parts":["unknown","secret. visible"," after"],"startKnown":false,"endKnown":true}}),
        );
        assert_eq!(reply["parts"][1], privacy::PLACEHOLDER);
        assert_eq!(reply["selectionUnavailable"], true);
        let empty = call(
            json!({"caretWindow":{"parts":["unknown","","tail"],"startKnown":false,"endKnown":false}}),
        );
        assert_eq!(empty["parts"], json!(["", "", ""]));
        assert_eq!(empty["selectionUnavailable"], false);
    }
    #[test]
    fn withheld_caret_does_not_present_distant_source_as_adjacent_context() {
        let reply = call(
            json!({"caretWindow":{"parts":["Visible. unfinished","","token"],"startKnown":true,"endKnown":false}}),
        );
        assert_eq!(reply["parts"], json!(["", "", ""]));
        assert_eq!(reply["selectionUnavailable"], false);
    }
    #[test]
    fn unavailable_selection_cannot_erase_a_secret_prefix_needed_by_the_after_side() {
        let reply = call(
            json!({"caretWindow":{"parts":["unknown","fragment. password=","syntheticSecret123"],"startKnown":false,"endKnown":true}}),
        );
        assert_eq!(reply["parts"], json!(["", privacy::PLACEHOLDER, ""]));
        assert_eq!(reply["selectionUnavailable"], true);
    }
    #[test]
    fn caret_window_retains_both_large_recognition_sides_until_redaction() {
        let parts = json!(["x".repeat(SCREEN), "selected", "y".repeat(SCREEN)]);
        let reply = call(json!({"caretWindow":{"parts":parts,"startKnown":true,"endKnown":true}}));
        assert_eq!(reply["parts"], parts);
        assert_eq!(reply["selectionUnavailable"], false);
    }
    #[test]
    fn caret_window_requires_actual_source_edge_facts() {
        assert!(
            process(&serde_json::to_vec(&json!({"caretWindow":{"parts":["","",""]}})).unwrap())
                .is_err()
        );
    }
    #[test]
    fn recognition_halo_does_not_consume_the_presentation_reservation() {
        let parts = json!(["x".repeat(SCREEN), "selected", "y".repeat(SCREEN)]);
        let reserved = call(json!({"reserveCaret":parts}));
        assert_eq!(reserved["used"], 4_000 + 8 + 6);
        assert_eq!(reserved["budgetFull"], false);
        let reply = call(json!({"blocks":[{"kind":"field","text":"visible"}],"caret":parts}));
        assert_eq!(
            reply["caret"],
            json!(["x".repeat(2_000), "selected", "y".repeat(2_000)])
        );
        assert_eq!(reply["blocks"][0]["text"], "visible");
    }
    #[test]
    fn recognition_halo_is_redacted_before_nearest_context_is_selected() {
        let before = format!("password={}syntheticSecret123", " ".repeat(SCREEN - 40));
        let reply = call(json!({"blocks":[],"caret":[before,"","Visible. ".repeat(5_000)]}));
        assert!(
            !reply["caret"][0]
                .as_str()
                .unwrap()
                .contains("syntheticSecret123")
        );
        assert!(
            reply["caret"][0]
                .as_str()
                .unwrap()
                .contains(privacy::PLACEHOLDER)
        );
    }
    #[test]
    fn full_selection_and_each_source_side_have_independent_finite_bounds() {
        let selection = "s".repeat(SCREEN - 6);
        let parts = json!(["x".repeat(SCREEN), selection, "y".repeat(SCREEN)]);
        let reserved = call(json!({"reserveCaret":parts}));
        assert_eq!(reserved["used"], SCREEN);
        let reply = call(json!({"blocks":[],"caret":parts}));
        assert_eq!(reply["caret"], json!(["", selection, ""]));
        for parts in [
            json!(["x".repeat(SCREEN + 1), "", ""]),
            json!(["", "", "y".repeat(SCREEN + 1)]),
            json!(["", "s".repeat(SCREEN - 5), ""]),
        ] {
            assert!(process(&serde_json::to_vec(&json!({"reserveCaret":parts})).unwrap()).is_err());
        }
    }
    #[test]
    fn admission_preserves_complete_source_and_returns_the_common_stop_decision() {
        let reserved = call(json!({"reserveCaret":["left","selected","right"]}));
        assert_eq!(reserved["used"], 4 + 8 + 5 + 6);
        let input = format!("{} token=syntheticSecret123", "x".repeat(SCREEN - 30));
        let reply = call(json!({"admit":input,"used":reserved["used"]}));
        assert_eq!(reply["text"], input);
        assert_eq!(reply["budgetFull"], true);
        let next = call(json!({"admit":"must not be admitted","used":reply["used"]}));
        assert_eq!(next["text"], "");
        assert_eq!(next["budgetFull"], true);
    }
    #[test]
    fn admission_skips_canonical_adjacent_duplicates_without_spending_budget() {
        let reply = call(json!({"admit":" e\u{301} ","previous":"é","used":17}));
        assert_eq!(reply, json!({"text":"","used":17,"budgetFull":false}));
    }
    #[test]
    fn caret_is_reserved_once_even_when_its_block_is_late() {
        let reply = call(json!({"blocks":[{"kind":"field","text":"x".repeat(SCREEN)},
            {"kind":"caret","text":"ignored duplicate source"}],"caret":["left","chosen","right"]}));
        let blocks = reply["blocks"].as_array().unwrap();
        assert_eq!(reply["caret"], json!(["left", "chosen", "right"]));
        assert_eq!(blocks[1]["text"], "left‸chosen‸right");
        assert_eq!(
            blocks
                .iter()
                .map(|b| b["text"].as_str().unwrap().len())
                .sum::<usize>(),
            SCREEN
        );
        assert_eq!(reply["truncated"], true);
    }
    #[test]
    fn final_semantic_prefix_follows_redaction_and_keeps_graphemes_whole() {
        let text = format!("{} {}{}", "x".repeat(19_994), "AKIA", "A".repeat(16));
        let reply = call(json!({"blocks":[{"kind":"row","text":text}],"caret":["","",""]}));
        let shown = reply["blocks"][0]["text"].as_str().unwrap();
        assert!(!shown.contains("AKIA"));
        assert!(shown.graphemes(true).count() <= 20_000);
        assert_eq!(reply["truncated"], true);
        let family = "👨‍👩‍👧‍👦";
        let reply = call(
            json!({"blocks":[{"kind":"field","text":family.repeat(10_486)}],"caret":["","",""]}),
        );
        let shown = reply["blocks"][0]["text"].as_str().unwrap();
        assert!(shown.graphemes(true).all(|g| g == family));
        assert!(shown.len() <= SCREEN - "‸".len());
    }
    #[test]
    fn row_limit_does_not_leave_an_incomplete_join_separator() {
        for padding in [19_997, 19_998, 19_999] {
            let text = format!("{} | next", "x".repeat(padding));
            let reply = call(json!({"blocks":[{"kind":"row","text":text}]}));
            assert_eq!(reply["blocks"][0]["text"], "x".repeat(padding));
        }
    }
    #[test]
    fn large_selection_refuses_instead_of_becoming_a_different_edit_target() {
        let request = json!({"blocks":[],"caret":["","x".repeat(SCREEN),""]});
        assert!(process(&serde_json::to_vec(&request).unwrap()).is_err());
        let duplicate = json!({"blocks":[{"kind":"caret","text":"a"},{"kind":"caret","text":"b"}],"caret":["","",""]});
        assert!(process(&serde_json::to_vec(&duplicate).unwrap()).is_err());
    }
    #[test]
    fn caret_context_retains_the_nearest_shared_graphemes() {
        let reply = call(
            json!({"blocks":[],"caret":[format!("old{}", "é".repeat(2_000)),"chosen",format!("{}old", "👨‍👩‍👧‍👦".repeat(2_000))]}),
        );
        assert_eq!(
            reply["caret"],
            json!(["é".repeat(2_000), "chosen", "👨‍👩‍👧‍👦".repeat(2_000)])
        );
        assert_eq!(reply["selectionRedacted"], false);
        assert_eq!(reply["truncated"], true);
    }
    #[test]
    fn field_recognition_context_is_redacted_before_visible_projection() {
        let request = json!({"blocks":[{"kind":"field","text":"syntheticSecret123", "source":["Offscreen heading. password: ","syntheticSecret123",". Offscreen footer"]}], "caret":["","",""]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert_eq!(result["blocks"][0]["text"], privacy::PLACEHOLDER);
        assert_eq!(result["rendered"], "> [redacted]");
        assert!(result["blocks"][0].get("source").is_none());
    }
    #[test]
    fn field_projection_preserves_raw_whitespace_until_combined_redaction() {
        let request = json!({"blocks":[{"kind":"field","text":" syntheticSecret123", "source":["Bearer"," syntheticSecret123",". "]}], "caret":["","",""]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert!(
            !result["rendered"]
                .as_str()
                .unwrap()
                .contains("syntheticSecret123")
        );
    }
    #[test]
    fn field_source_is_not_rendered_even_without_a_caret_request() {
        let request = json!({"blocks":[{"kind":"field","text":"Visible", "source":["Private prefix. ","Visible",". Private suffix"]}]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert_eq!(result["rendered"], "> Visible");
        assert!(result["blocks"][0].get("source").is_none());
    }
    #[test]
    fn field_source_requires_matching_target_and_bounded_parts() {
        for source in [
            json!(["a", "different", "b"]),
            json!(["target"]),
            json!(["a", 3, "b"]),
            json!(["x".repeat(SOURCE_WINDOW_BYTES + 1), "target", ""]),
        ] {
            let request = json!({"blocks":[{"kind":"field","text":"target","source":source}],"caret":["","",""]});
            assert!(process(&serde_json::to_vec(&request).unwrap()).is_err());
        }
    }
    #[test]
    fn field_source_admission_charges_all_private_bytes_without_normalizing_parts() {
        let parts = json!(["Bearer", " syntheticSecret123", ". "]);
        let result: Value = serde_json::from_slice(
            &process(&serde_json::to_vec(&json!({"admitField":parts,"used":0})).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(result["parts"], parts);
        assert_eq!(result["used"], "Bearer syntheticSecret123. ".len());
        let result: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(&json!({"admitField":["a","visible","b"],"used":SCREEN_BYTES}))
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["parts"], json!(["", "", ""]));
        assert_eq!(result["used"], SCREEN_BYTES);
    }
    #[test]
    fn semantic_runs_redact_private_source_and_preserve_visible_joiners() {
        let request = json!({"blocks":[{"kind":"row","text":"Label | syntheticSecret123",
            "runs":[["Label | ",true],["password: ",false],["syntheticSecret123",true]]}]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert_eq!(result["rendered"], "| Label | [redacted]");
        assert!(result["blocks"][0].get("runs").is_none());
    }
    #[test]
    fn semantic_admission_deduplicates_only_equivalent_recognition_source() {
        let value = json!({"kind":"row","text":"same","runs":[["password: ",false],["same",true]]});
        let admit = |previous| -> Value {
            serde_json::from_slice(
                &process(
                    &serde_json::to_vec(
                        &json!({"admitSemantic":value,"used":10,"previous":previous}),
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(admit(value.clone())["text"], "");
        assert_eq!(
            admit(json!({"kind":"row","text":"same","runs":[["public ",false],["same",true]]}))["text"],
            "same"
        );
        assert_eq!(admit(json!({"kind":"text","text":"same"}))["text"], "same");
        let plain = json!({"kind":"row","text":"same","runs":[["same",true]]});
        let result: Value = serde_json::from_slice(&process(&serde_json::to_vec(&json!({"admitSemantic":plain,"used":10,"previous":{"kind":"text","text":"same"}})).unwrap()).unwrap()).unwrap();
        assert_eq!(result["text"], "");
    }
    #[test]
    fn semantic_admission_charges_private_bytes_and_stops_further_sources() {
        let block = json!({"kind":"row","text":"visible","runs":[["x".repeat(SOURCE_WINDOW_BYTES),false],["visible",true]]});
        let admit = |used| -> Value {
            serde_json::from_slice(
                &process(&serde_json::to_vec(&json!({"admitSemantic":block,"used":used})).unwrap())
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(admit(0)["used"], SOURCE_WINDOW_BYTES + 7);
        assert_eq!(admit(0)["budgetFull"], true);
        assert_eq!(admit(SCREEN_BYTES)["runs"], json!([]));
        assert_eq!(admit(SCREEN_BYTES)["used"], SCREEN_BYTES);
        let invalid = json!({"blocks":[{"kind":"row","text":"", "runs":vec![("x".repeat(SOURCE_WINDOW_BYTES),false);5]}]});
        assert!(process(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    #[test]
    fn semantic_run_metadata_is_validated_not_ignored() {
        for runs in [
            json!([["different", true]]),
            json!([["text", 1]]),
            json!([["text", true, "extra"]]),
        ] {
            let request = json!({"blocks":[{"kind":"heading","text":"text","runs":runs}]});
            assert!(process(&serde_json::to_vec(&request).unwrap()).is_err());
        }
    }
    #[test]
    fn ordinary_block_window_and_probes_share_the_screen_source_allowance() {
        let text = "x".repeat(300_000);
        let result: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(
                    &json!({"blockWindow":{"text":text,"startKnown":true,"endKnown":true}}),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["text"], text);
        let probes: Value =
            serde_json::from_slice(&process(br#"{"opaqueProbes":true,"scope":"block"}"#).unwrap())
                .unwrap();
        assert_eq!(probes["amounts"][0], BLOCK_SOURCE_BYTES);
        assert!(process(br#"{"opaqueProbes":true,"scope":"unknown"}"#).is_err());
    }
    #[test]
    fn opaque_field_window_keeps_projection_and_withholds_unknown_edges() {
        let project = |parts, start, end| -> Value {
            serde_json::from_slice(
                &process(
                    &serde_json::to_vec(
                        &json!({"fieldWindow":{"parts":parts,"startKnown":start,"endKnown":end}}),
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            project(json!(["password: ", "syntheticSecret123", ""]), true, true)["parts"],
            json!(["password: ", "syntheticSecret123", ""])
        );
        assert_eq!(
            project(
                json!(["unknown", "Secret123. Visible! ", "tail"]),
                false,
                false
            )["parts"],
            json!(["", ". Visible! ", ""])
        );
        assert!(
            process(&serde_json::to_vec(&json!({"fieldWindow":{"parts":["","x",""]}})).unwrap())
                .is_err()
        );
    }
    #[test]
    fn field_ranges_preserve_hidden_gaps_and_reject_invalid_metadata() {
        let ranges = |count, ranges| {
            process(
                &serde_json::to_vec(&json!({"fieldRanges":{"count":count,"ranges":ranges}}))
                    .unwrap(),
            )
        };
        let value: Value = serde_json::from_slice(
            &ranges(
                100,
                json!([[40, 50], [10, 20], [18, 30], [30, 35], [0, 0], [40, 45]]),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["ranges"], json!([[10, 35], [40, 50]]));
        for invalid in [
            json!([[-1, 1]]),
            json!([[2, 1]]),
            json!([[0, 101]]),
            json!([[0, 1.5]]),
            json!([[0, 1, 2]]),
        ] {
            assert!(ranges(100, invalid).is_err());
        }
        assert!(ranges(100, json!(vec![[0, 1]; 65])).is_err());
        assert!(ranges(100, json!([])).is_ok());
    }
    #[test]
    fn field_plan_separates_native_lower_bound_from_grapheme_eligibility() {
        let plan = |value| -> Value {
            serde_json::from_slice(
                &process(&serde_json::to_vec(&json!({"fieldPlan":value})).unwrap()).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            plan(json!({"count":SOURCE_WINDOW_BYTES+1}))["probeWhole"],
            false
        );
        assert_eq!(
            plan(json!({"count":SOURCE_WINDOW_BYTES}))["probeWhole"],
            true
        );
        assert_eq!(plan(json!({}))["probeWhole"], true);
        assert_eq!(plan(json!({"text":"😀".repeat(15000)}))["useWhole"], true);
        assert_eq!(plan(json!({"text":"x".repeat(20001)}))["useWhole"], false);
        assert_eq!(
            plan(json!({"text":"e\u{301}".repeat(20000)}))["useWhole"],
            true
        );
        for value in [
            json!(false),
            json!({"count":-1}),
            json!({"count":1.5}),
            json!({"text":3}),
        ] {
            assert!(process(&serde_json::to_vec(&json!({"fieldPlan":value})).unwrap()).is_err());
        }
    }
    #[test]
    fn standalone_field_projection_redacts_and_requires_caret_parts_when_present() {
        let block = json!({"kind":"field","text":"syntheticSecret123","source":["password: ","syntheticSecret123",""]});
        let result: Value = serde_json::from_slice(
            &process(&serde_json::to_vec(&json!({"blocks":[block.clone()]})).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(result["rendered"], "> [redacted]");
        assert!(
            process(
                &serde_json::to_vec(&json!({"blocks":[block,{"kind":"caret","text":"raw caret"}]}))
                    .unwrap()
            )
            .is_err()
        );
    }
}
