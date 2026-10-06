// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One terminal surface as the viewport projection takes it, built once for every helper that reads
//! a terminal as one document (ADR-DESK-054): the helper sends what it read (the visible spans of the
//! document and their text, the selections and where the caret is drawn) and gets back the surface's
//! runs, its selection and the caret. The helper keeps the reads themselves and their geometry.

use super::{MAX_BYTES, MAX_RUNS, boolean, number};
use serde_json::{Value, json};

/// A pair of document offsets `[start, end]` with `start <= end <= count`.
fn span(value: &Value, count: usize) -> Option<(usize, usize)> {
    let pair = value.as_array().filter(|pair| pair.len() == 2)?;
    let (start, end) = (number(&pair[0]).ok()?, number(&pair[1]).ok()?);
    (start <= end && end <= count).then_some((start, end))
}

/// `[x, y, width, height]`, every value finite and the size not negative.
fn rectangle(value: &Value) -> Result<[f64; 4], u32> {
    let values = value
        .as_array()
        .filter(|values| values.len() == 4)
        .ok_or(1u32)?;
    let mut result = [0.0; 4];
    for (slot, value) in result.iter_mut().zip(values) {
        *slot = value.as_f64().filter(|n| n.is_finite()).ok_or(1u32)?;
    }
    if result[2] < 0.0 || result[3] < 0.0 {
        return Err(1);
    }
    Ok(result)
}

/// Whether a caret drawn at `caret` is inside `clip`: its leading edge within the clip's width, edges
/// included, and some of its height within the clip's.
fn drawn_inside(caret: &[f64; 4], clip: &[f64; 4]) -> bool {
    caret[0] >= clip[0]
        && caret[0] <= clip[0] + clip[2]
        && caret[1] + caret[3] > clip[1]
        && caret[1] < clip[1] + clip[3]
}

pub(super) fn build(input: &Value) -> Result<Vec<u8>, u32> {
    let id = number(&input["id"])?;
    let frame = rectangle(&input["frame"])?;
    if frame[2] <= 0.0 || frame[3] <= 0.0 {
        return Err(1);
    }
    let scalar = match input["offsetUnit"].as_str() {
        Some("utf16") => false,
        Some("scalar") => true,
        _ => return Err(1),
    };
    let count = number(&input["count"])?;
    let start_known = boolean(&input["startKnown"])?;
    let end_known = boolean(&input["endKnown"])?;
    let spans = input["spans"].as_array().ok_or(1u32)?;
    let texts = input["texts"].as_array().ok_or(1u32)?;
    if spans.len() > MAX_RUNS || texts.len() != spans.len() {
        return Err(1);
    }
    // The text read is what the budget counts, in UTF-8 bytes whatever unit the helper reads in.
    let budget = number(&input["bytes"])?.min(MAX_BYTES);
    let mut runs = Vec::new();
    let mut bounds: Vec<(usize, usize)> = Vec::new();
    let mut bytes = 0usize;
    for (index, (value, text)) in spans.iter().zip(texts).enumerate() {
        let (start, end) = span(value, count).ok_or(1u32)?;
        if bounds.last().is_some_and(|&(_, previous)| previous > start) {
            return Err(1);
        }
        let text = text.as_str().ok_or(1u32)?;
        let length = if scalar {
            text.chars().count()
        } else {
            text.encode_utf16().count()
        };
        bytes = bytes.checked_add(text.len()).ok_or(1u32)?;
        if length != end - start || bytes > budget {
            return Err(1);
        }
        runs.push(json!({"id": index, "text": text,
            "connected": bounds.last().is_some_and(|&(_, previous)| previous == start),
            "startKnown": start_known && start == 0, "endKnown": end_known && end == count}));
        bounds.push((start, end));
    }
    // A selection the helper could not read, or one that does not fit the document, is withheld; one
    // partly outside the visible spans is not complete, so the app never rewrites it.
    let selections = match &input["selections"] {
        Value::Null => None,
        Value::Array(values) if values.len() <= MAX_RUNS => {
            let parsed: Option<Vec<(usize, usize)>> =
                values.iter().map(|value| span(value, count)).collect();
            parsed.filter(|ranges| ranges.windows(2).all(|pair| pair[0].1 <= pair[1].0))
        }
        _ => return Err(1),
    };
    let mut ranges = Vec::new();
    let mut complete = selections.is_some();
    for &(from, to) in selections.iter().flatten() {
        let mut covered = 0;
        for (index, &(start, end)) in bounds.iter().enumerate() {
            let (a, b) = (from.max(start), to.min(end));
            if a < b {
                covered += b - a;
                ranges.push(json!({"run": index, "start": a - start, "end": b - start}));
            }
        }
        complete &= covered == to - from;
    }
    let caret = match &input["caret"] {
        Value::Null => json!({"status": "unavailable"}),
        caret => {
            let offset = number(&caret["offset"])?;
            let drawn = match &caret["frame"] {
                Value::Null => None,
                value => Some(rectangle(value)?),
            };
            // A caret between two spans belongs to the one it starts; at the end of a span, to that span.
            // One the provider places past its own text is in no span, so not in view.
            let run = bounds
                .iter()
                .position(|&(start, end)| start <= offset && offset < end)
                .or_else(|| bounds.iter().position(|&(_, end)| end == offset));
            match run {
                Some(run) if drawn.is_some_and(|drawn| drawn_inside(&drawn, &frame)) => {
                    json!({"status": "exact", "surface": id, "run": run, "offset": offset - bounds[run].0})
                }
                _ => json!({"status": "outsideViewport"}),
            }
        }
    };
    serde_json::to_vec(&json!({
        "surface": {"id": id, "frame": input["frame"], "runs": runs,
            "selection": {"complete": complete, "ranges": ranges}},
        "caret": caret,
    }))
    .map_err(|_| 3)
}
