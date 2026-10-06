// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Projection of already-authorized, visible-only native text. This module never
//! acquires text or infers focus/visibility from strings or terminal cell columns.
use crate::privacy;
use serde_json::{Value, json};
use std::collections::HashSet;

const MAX_SURFACES: usize = 64;
const MAX_RUNS: usize = 1024;
const MAX_BYTES: usize = crate::semantic::MAX_BYTES;

fn number(value: &Value) -> Result<usize, u32> {
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(1)
}
fn boolean(value: &Value) -> Result<bool, u32> {
    value.as_bool().ok_or(1)
}
fn byte_offset(text: &str, position: usize) -> Result<usize, u32> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == position {
            return Ok(byte);
        }
        units += ch.len_utf16();
        if units > position {
            return Err(1);
        }
    }
    if units == position {
        Ok(text.len())
    } else {
        Err(1)
    }
}

fn insertion_offset(text: &str, position: usize, scalar: bool) -> Result<usize, u32> {
    if !scalar {
        byte_offset(text, position)?;
        return Ok(position);
    }
    let mut count = 0;
    let mut units = 0;
    for ch in text.chars() {
        if count == position {
            return Ok(units);
        }
        count += 1;
        units += ch.len_utf16();
    }
    if count == position { Ok(units) } else { Err(1) }
}

/// iTerm2 writes NUL in its accessibility text for a cell that holds no character of its own: the
/// right half of a double-width character, and a cell nothing was written to (tmux skips blank cells
/// by moving the cursor). A NUL right after a non-ASCII character is taken for its right half and
/// dropped, since iTerm2's widths depend on its settings (ambiguous-width letters, flags) but an
/// ASCII character is never double width; any other NUL is a blank on screen and reads as a space.
/// Dropping can only join text, so it never splits a secret away from redaction. Returns the text
/// and the UTF-16 offsets, in the native text, of the NULs dropped.
fn blank_cells(native: &str) -> (String, Vec<usize>) {
    let mut text = String::with_capacity(native.len());
    let mut dropped = Vec::new();
    let mut units = 0;
    let mut after_wide = false;
    for ch in native.chars() {
        if ch == '\0' {
            if after_wide {
                dropped.push(units);
            } else {
                text.push(' ');
            }
            after_wide = false;
        } else {
            text.push(ch);
            after_wide = !ch.is_ascii();
        }
        units += ch.len_utf16();
    }
    (text, dropped)
}

struct Run<'a> {
    id: usize,
    native: &'a str,
    text: String,
    /// UTF-16 offsets in `native` of the NULs `blank_cells` dropped.
    dropped: Vec<usize>,
    connected: bool,
}

impl Run<'_> {
    /// A native insertion offset as an offset in `text`.
    fn offset(&self, position: usize, scalar: bool) -> Result<usize, u32> {
        let units = insertion_offset(self.native, position, scalar)?;
        Ok(units - self.dropped.iter().take_while(|&&at| at < units).count())
    }
}
struct Selection {
    run: usize,
    start: usize,
    end: usize,
}

pub(crate) fn process(bytes: &[u8]) -> Result<Vec<u8>, u32> {
    let request: Value = serde_json::from_slice(bytes).map_err(|_| 1u32)?;
    if request == json!({"limits":true}) {
        return serde_json::to_vec(
            &json!({"bytes":MAX_BYTES,"runs":MAX_RUNS,"surfaces":MAX_SURFACES}),
        )
        .map_err(|_| 3);
    }
    let surfaces = request["surfaces"].as_array().ok_or(1u32)?;
    if surfaces.len() > MAX_SURFACES {
        return Err(1);
    }
    let scalar = match request.get("offsetUnit").and_then(Value::as_str) {
        None if request.get("offsetUnit").is_none() => false,
        Some("utf16") => false,
        Some("scalar") => true,
        _ => return Err(1),
    };
    let focused = if request["focusedSurface"].is_null() {
        None
    } else {
        Some(number(&request["focusedSurface"])?)
    };
    let complete = boolean(&request["complete"])?;
    let caret = &request["caret"];
    let status = caret["status"].as_str().ok_or(1u32)?;
    if !["exact", "outsideViewport", "unavailable", "withheld"].contains(&status) {
        return Err(1);
    }
    let exact = if status == "exact" {
        let surface = number(&caret["surface"])?;
        if focused != Some(surface) {
            return Err(1);
        }
        Some((surface, number(&caret["run"])?, number(&caret["offset"])?))
    } else {
        None
    };
    let mut output_caret = json!({"status": if exact.is_some() { "withheld" } else { status }});
    let mut found_caret = exact.is_none();
    let mut ids = HashSet::new();
    let mut total_bytes = 0usize;
    let mut total_runs = 0usize;
    let mut output = Vec::new();
    // An incomplete capture without a focused surface has not established an
    // empty selection. Preserve refusal at the writing boundary on every OS.
    let mut selection_complete = complete || focused.is_some();
    let mut selected_text = if selection_complete {
        String::new()
    } else {
        privacy::PLACEHOLDER.to_owned()
    };
    for surface in surfaces {
        let id = number(&surface["id"])?;
        if !ids.insert(id) {
            return Err(1);
        }
        let frame = surface["frame"].as_array().ok_or(1u32)?;
        if frame.len() != 4
            || frame
                .iter()
                .any(|v| v.as_f64().is_none_or(|n| !n.is_finite()))
            || frame[2].as_f64().unwrap() < 0.0
            || frame[3].as_f64().unwrap() < 0.0
        {
            return Err(1);
        }
        let values = surface["runs"].as_array().ok_or(1u32)?;
        total_runs = total_runs.checked_add(values.len()).ok_or(1u32)?;
        if total_runs > MAX_RUNS {
            return Err(1);
        }
        let mut runs = Vec::new();
        let mut run_ids = HashSet::new();
        for value in values {
            let run_id = number(&value["id"])?;
            if !run_ids.insert(run_id) {
                return Err(1);
            }
            let text = value["text"].as_str().ok_or(1u32)?;
            total_bytes = total_bytes.checked_add(text.len()).ok_or(1u32)?;
            if total_bytes > MAX_BYTES {
                return Err(1);
            }
            let connected = boolean(&value["connected"])?;
            if runs.is_empty() && connected {
                return Err(1);
            }
            boolean(&value["startKnown"])?;
            boolean(&value["endKnown"])?;
            let (blanked, dropped) = blank_cells(text);
            runs.push(Run {
                id: run_id,
                native: text,
                text: blanked,
                dropped,
                connected,
            });
        }
        let selection = &surface["selection"];
        let mut safe_selection = boolean(&selection["complete"])?;
        let ranges = selection["ranges"].as_array().ok_or(1u32)?;
        if ranges.len() > MAX_RUNS {
            return Err(1);
        }
        let mut selections = Vec::new();
        let mut previous = None;
        for range in ranges {
            let run_id = number(&range["run"])?;
            let index = runs.iter().position(|run| run.id == run_id).ok_or(1u32)?;
            let start = runs[index].offset(number(&range["start"])?, scalar)?;
            let end = runs[index].offset(number(&range["end"])?, scalar)?;
            if start > end
                || previous.is_some_and(|(old_index, old_end)| {
                    index < old_index || (index == old_index && start < old_end)
                })
            {
                return Err(1);
            }
            byte_offset(&runs[index].text, start)?;
            byte_offset(&runs[index].text, end)?;
            if let Some((old_index, old_end)) = previous {
                // A disjoint/rectangular selection is useful context, but the
                // existing replacement operation can act on only one interval.
                safe_selection &= (index == old_index && start == old_end)
                    || (index == old_index + 1
                        && runs[index].connected
                        && start == 0
                        && old_end == runs[old_index].text.encode_utf16().count());
            }
            previous = Some((index, end));
            selections.push(Selection {
                run: index,
                start,
                end,
            });
        }
        let mut output_runs = Vec::new();
        let mut output_selection = Vec::new();
        let mut surface_selection = String::new();
        let mut first = 0;
        while first < runs.len() {
            let mut end = first + 1;
            while end < runs.len() && runs[end].connected {
                end += 1;
            }
            let group = &runs[first..end];
            // Visible capture edges follow the established screen-redaction contract:
            // redact recognizable secrets, retaining ordinary fragments and native anchors.
            // Only source-contiguous runs share recognition state; hidden gaps stay separate.
            let parts = group.iter().map(|run| run.text.to_owned()).collect();
            let mut starts = Vec::new();
            let mut unit_start = 0;
            for run in group {
                starts.push(unit_start);
                unit_start += run.text.encode_utf16().count();
            }
            let mut positions = Vec::new();
            let mut caret_position = None;
            if let Some((surface_id, run_id, offset)) = exact
                && surface_id == id
                && let Some(index) = group.iter().position(|r| r.id == run_id)
            {
                found_caret = true;
                caret_position = Some((positions.len(), index));
                positions.push(starts[index] + group[index].offset(offset, scalar)?);
            }
            let mut selection_positions = Vec::new();
            for selection in selections.iter().filter(|s| s.run >= first && s.run < end) {
                let index = selection.run - first;
                selection_positions.push((positions.len(), index, selection.start, selection.end));
                positions.extend([
                    starts[index] + selection.start,
                    starts[index] + selection.end,
                ]);
            }
            let (redacted, mapped) =
                privacy::redact_anchored(&vec![parts], &positions).map_err(|_| 3u32)?;
            let redacted = &redacted[0];
            let mut output_starts = Vec::new();
            let mut offset = 0;
            for text in redacted {
                output_starts.push(offset);
                offset += text.encode_utf16().count();
            }
            if let Some((position, index)) = caret_position
                && let Some(offset) = mapped[position]
            {
                let local = offset.checked_sub(output_starts[index]).ok_or(3u32)?;
                byte_offset(&redacted[index], local)?;
                output_caret =
                    json!({"status":"exact", "surface":id, "run":group[index].id, "offset":local});
            }
            for (position, index, start, end) in selection_positions {
                if let (Some(a), Some(b)) = (mapped[position], mapped[position + 1]) {
                    let local_a = a.checked_sub(output_starts[index]).ok_or(3u32)?;
                    let local_b = b.checked_sub(output_starts[index]).ok_or(3u32)?;
                    let selected = &redacted[index][byte_offset(&redacted[index], local_a)?
                        ..byte_offset(&redacted[index], local_b)?];
                    let original = &group[index].text[byte_offset(&group[index].text, start)?
                        ..byte_offset(&group[index].text, end)?];
                    let unchanged = selected == original;
                    safe_selection &= unchanged;
                    output_selection.push(json!({"run":group[index].id,"start":local_a,"end":local_b,"redacted":!unchanged}));
                    surface_selection.push_str(selected);
                } else {
                    safe_selection = false;
                }
            }
            for (index, run) in group.iter().enumerate() {
                output_runs.push(
                    json!({"id":run.id,"text":redacted[index],"connected":run.connected,
                    "complete": true}),
                );
            }
            first = end;
        }
        if focused == Some(id) {
            selection_complete = safe_selection;
            selected_text = if safe_selection {
                surface_selection
            } else {
                privacy::PLACEHOLDER.to_owned()
            };
        }
        output.push(json!({"id":id,"frame":frame,"runs":output_runs,"selection":{"complete":safe_selection,"ranges":output_selection}}));
    }
    if !found_caret || focused.is_some_and(|id| !ids.contains(&id)) {
        return Err(1);
    }
    // Layout labels are inserted only after source redaction. Positions are
    // computed while rendering, never recovered by matching repeated text.
    let mut rendered = String::new();
    let mut rendered_units = 0;
    for surface in &mut output {
        let id = number(&surface["id"])?;
        let label = format!(
            "{}[Terminal surface {}]\n",
            if rendered.is_empty() { "" } else { "\n" },
            id
        );
        rendered_units += label.encode_utf16().count();
        rendered.push_str(&label);
        let mut offsets = Vec::new();
        for (index, run) in surface["runs"]
            .as_array_mut()
            .ok_or(3u32)?
            .iter_mut()
            .enumerate()
        {
            if index > 0 && run["connected"] == false {
                let gap = "\n[viewport gap]\n";
                rendered.push_str(gap);
                rendered_units += gap.len();
            }
            let run_id = number(&run["id"])?;
            offsets.push((run_id, rendered_units));
            if output_caret["status"] == "exact"
                && output_caret["surface"] == id
                && output_caret["run"] == run_id
            {
                output_caret["renderedOffset"] =
                    json!(rendered_units + number(&output_caret["offset"])?);
            }
            run["renderedOffset"] = json!(rendered_units);
            let text = run["text"].as_str().ok_or(3u32)?;
            rendered.push_str(text);
            rendered_units += text.encode_utf16().count();
        }
        for range in surface["selection"]["ranges"].as_array_mut().ok_or(3u32)? {
            let run_id = number(&range["run"])?;
            let start = offsets.iter().find(|(id, _)| *id == run_id).ok_or(3u32)?.1;
            range["renderedStart"] = json!(start + number(&range["start"])?);
            range["renderedEnd"] = json!(start + number(&range["end"])?);
        }
    }
    serde_json::to_vec(
        &json!({"renderedText":rendered,"surfaces":output,"caret":output_caret,"complete":complete,
        "selectedText":selected_text,"selectionComplete":selection_complete}),
    )
    .map_err(|_| 3)
}

#[cfg(test)]
mod tests;
