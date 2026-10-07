// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A terminal window's surfaces gathered into one viewport, for every helper that reads one
//! (ADR-DESK-054). The helper walks the window, finds each surface and reads it; what is gathered,
//! how many surfaces and how many bytes, and what the viewport says when it is done are decided here.
//! The helper carries the state between calls and never changes it.
//!
//! - `{"start": true}`: the state before any surface.
//! - `{"state": S, "next": true}`: whether to read another surface (`read`), with its `id` and the
//!   `bytes` it may hold. When not, the window holds more than is read, and the walk stops.
//! - `{"state": S, "take": {"surface", "caret"}, "focused": bool}`: the state with a surface the
//!   `surface` op built added; a surface over the bytes left, or not the next one, refuses the read.
//! - `{"state": S, "finish": {"complete": bool, "offsetUnit"?}}`: the viewport, complete only when
//!   the walk saw everything (`complete`) and found a surface.
//! - `{"plan": {"count", "spans", "bytes"}}`: whether spans planned in a document of `count` units may
//!   be read: in order, apart, within the document, at most `MAX_RUNS`, and no more units than
//!   `bytes` (each unit is at least one byte).

use super::{MAX_BYTES, MAX_RUNS, MAX_SURFACES, boolean, number};
use serde_json::{Value, json};

fn state(value: &Value) -> Result<(&Vec<Value>, usize), u32> {
    let surfaces = value["surfaces"].as_array().ok_or(1u32)?;
    let remaining = number(&value["remaining"])?;
    if surfaces.len() > MAX_SURFACES || remaining > MAX_BYTES {
        return Err(1);
    }
    Ok((surfaces, remaining))
}

fn plan(input: &Value) -> Result<Value, u32> {
    let count = number(&input["count"])?;
    let budget = number(&input["bytes"])?;
    let spans = input["spans"].as_array().ok_or(1u32)?;
    let mut previous = 0usize;
    let mut units = 0usize;
    let mut admit = spans.len() <= MAX_RUNS;
    for value in spans {
        let pair = value
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or(1u32)?;
        let (start, end) = (number(&pair[0])?, number(&pair[1])?);
        if start < previous || end < start || end > count {
            admit = false;
            break;
        }
        units = units.checked_add(end - start).ok_or(1u32)?;
        previous = end;
    }
    Ok(json!({"admit": admit && units <= budget}))
}

pub(super) fn process(input: &Value) -> Result<Vec<u8>, u32> {
    let fields = input.as_object().ok_or(1u32)?;
    let reply = if let Some(planned) = input.get("plan") {
        if fields.len() != 1 {
            return Err(1);
        }
        plan(planned)?
    } else if input.get("start").is_some() {
        if fields.len() != 1 || input["start"] != json!(true) {
            return Err(1);
        }
        json!({"surfaces": [], "focusedSurface": null, "caret": {"status": "unavailable"},
            "remaining": MAX_BYTES})
    } else {
        let current = &input["state"];
        let (surfaces, remaining) = state(current)?;
        if fields.len() == 2 && input["next"] == json!(true) {
            json!({"read": surfaces.len() < MAX_SURFACES && remaining > 0,
                "id": surfaces.len(), "bytes": remaining})
        } else if let (Some(taken), 3) = (input.get("take"), fields.len()) {
            let focused = boolean(&input["focused"])?;
            let surface = &taken["surface"];
            if surfaces.len() >= MAX_SURFACES || number(&surface["id"])? != surfaces.len() {
                return Err(1);
            }
            let mut bytes = 0usize;
            for run in surface["runs"].as_array().ok_or(1u32)? {
                let text = run["text"].as_str().ok_or(1u32)?;
                bytes = bytes.checked_add(text.len()).ok_or(1u32)?;
            }
            if bytes > remaining {
                return Err(1);
            }
            let mut next = current.clone();
            next["surfaces"]
                .as_array_mut()
                .ok_or(1u32)?
                .push(surface.clone());
            next["remaining"] = json!(remaining - bytes);
            if focused {
                next["focusedSurface"] = json!(surfaces.len());
                next["caret"] = taken["caret"].clone();
            }
            next
        } else if let (Some(finish), 2) = (input.get("finish"), fields.len()) {
            let complete = boolean(&finish["complete"])?;
            let mut viewport = json!({"surfaces": surfaces, "focusedSurface": current["focusedSurface"],
                "caret": current["caret"], "complete": complete && !surfaces.is_empty()});
            match finish.get("offsetUnit") {
                None => {}
                Some(unit @ Value::String(name)) if name == "utf16" || name == "scalar" => {
                    viewport["offsetUnit"] = unit.clone();
                }
                Some(_) => return Err(1),
            }
            viewport
        } else {
            return Err(1);
        }
    };
    serde_json::to_vec(&reply).map_err(|_| 3)
}
