// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The screen walk's rules, written once for every helper (ADR-DESK-054). The helper walks the
//! window's accessibility tree and says what the OS tells it about each element, as a role from
//! the shared list below; the core says what to do with it: refuse the window, skip it, place the
//! caret, walk into it, or read it in one piece. It also decides what a look inside an element
//! for an excluded page found means, when a walk stops, and the walk's budgets.
//!
//! The roles: `page` (a web page), `text`, `heading`, `link`, `row` (a table row, read as one
//! block of its cells), `listItem` (a list's item: a row outside pages, walked into in a page),
//! `field` (text the user can edit), `control` (a button, check box, radio button or combo box:
//! interface chrome outside pages, content in one), `toolbar` (likewise), `chrome` (menus,
//! images, scroll bars, sliders: never read) and `other` (a container, walked into).

use serde_json::{Value, json};

/// The most elements one walk, or one look inside an element, visits.
const NODE_BUDGET: u64 = 5_000;
/// How long a screen read may walk, in milliseconds. It runs while the user speaks.
const TIME_BUDGET_MILLISECONDS: u64 = 1_500;
/// The most parents followed from the focused element up to its window (deep pages are ≈ 40).
const FOCUS_DEPTH: u64 = 200;

fn flag(value: &Value, key: &str) -> Result<bool, u32> {
    match value.get(key) {
        None => Ok(false),
        Some(Value::Bool(set)) => Ok(*set),
        _ => Err(1),
    }
}

fn number(value: &Value, key: &str) -> Result<u64, u32> {
    value.get(key).and_then(Value::as_u64).ok_or(1)
}

/// A frame as `[x, y, width, height]`, or none.
fn frame(value: &Value, key: &str) -> Result<Option<[f64; 4]>, u32> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(parts)) if parts.len() == 4 => {
            let mut frame = [0.0; 4];
            for (slot, part) in frame.iter_mut().zip(parts) {
                *slot = part.as_f64().filter(|part| part.is_finite()).ok_or(1u32)?;
            }
            Ok(Some(frame))
        }
        Some(_) => Err(1),
    }
}

/// Whether a box can show its own text: one at most `thin` across either way shows nothing
/// (screen-reader-only labels, list items scrolled out of view, hover-only actions); one that
/// reports no size (0×0) says nothing and counts as shown (owner, 2026-10-05).
fn shown_box(frame: Option<[f64; 4]>, thin: f64) -> bool {
    frame.is_none_or(|[_, _, width, height]| {
        (width <= 0.0 && height <= 0.0) || width.min(height) > thin
    })
}

/// A sized element wholly outside the window: it and what it holds are not read.
fn outside(frame: Option<[f64; 4]>, window: Option<[f64; 4]>) -> bool {
    match (frame, window) {
        (Some([x, y, width, height]), Some([wx, wy, wwidth, wheight])) => {
            width > 0.0
                && height > 0.0
                && (x + width <= wx || y + height <= wy || x >= wx + wwidth || y >= wy + wheight)
        }
        _ => false,
    }
}

/// `{"node": {...}}`: what to do with one element. `role` is from the module's list; `focus` is
/// `"self"` (the focused element), `"path"` (one of its ancestors) or absent; `part` is true
/// inside a heading, link or row being read in one piece. The flags `inPage`, `password`,
/// `pageExcluded` (a page whose site is excluded), `focusedField` (the focus is a field, read by
/// the caret), `selection` (the focus has a selection) and `hidden` (the OS says the element is
/// not drawn) default to false; `frame` and `window` are `[x, y, width, height]` or null; `thin`
/// is the thickest a box can be and still hide its text (1 point; DPI-scaled pixels).
///
/// The reply's `action`: `refuse` (the window shows an excluded page: nothing of it is used),
/// `skip`, `caret` (the focused field: the caret block goes here), `descend` (walk into it, its
/// children inside a page when `childrenInPage`), `text`, `field`, `semantic` (a heading, link or
/// row of `kind`, from its label and what it holds) or `caption` (a page's control: its drawn
/// caption, or, having none, walk into it; when not `shown` a control with a caption is skipped).
/// `caretFirst`: the focus's selection goes before it. `host`: the walk's page host is this
/// page's, unless it has one already. Every read in one piece looks inside the element for an
/// excluded page first (`look`).
fn node(facts: &Value) -> Result<Value, u32> {
    if !facts.is_object() {
        return Err(1);
    }
    let role = facts.get("role").and_then(Value::as_str).ok_or(1u32)?;
    if ![
        "page", "text", "heading", "link", "row", "listItem", "field", "control", "toolbar",
        "chrome", "other",
    ]
    .contains(&role)
    {
        return Err(1);
    }
    let focus = match facts.get("focus") {
        None | Some(Value::Null) => "",
        Some(Value::String(focus)) if focus == "self" || focus == "path" => focus.as_str(),
        Some(_) => return Err(1),
    };
    let part = flag(facts, "part")?;
    let in_page = flag(facts, "inPage")?;
    let excluded = role == "page" && flag(facts, "pageExcluded")?;
    let focused_field = flag(facts, "focusedField")?;
    let selection = flag(facts, "selection")?;
    let password = flag(facts, "password")?;
    let hidden = flag(facts, "hidden")?;
    let at = frame(facts, "frame")?;
    let window = frame(facts, "window")?;
    let thin = facts
        .get("thin")
        .and_then(Value::as_f64)
        .filter(|thin| thin.is_finite() && *thin >= 0.0)
        .ok_or(1u32)?;
    if part && !focus.is_empty() {
        return Err(1);
    }
    let children_in_page = in_page || role == "page";
    let descend = json!({"action": "descend", "childrenInPage": children_in_page});
    let mut caret_first = false;
    match focus {
        "self" => {
            if excluded {
                return Ok(json!({"action": "refuse"}));
            }
            if focused_field {
                return Ok(json!({"action": "caret"}));
            }
            caret_first = selection;
        }
        // The focus's ancestors are walked into whatever they are, so its caret lands in place.
        "path" => {
            return Ok(if excluded {
                json!({"action": "refuse"})
            } else {
                descend
            });
        }
        _ => {}
    }
    if excluded {
        return Ok(json!({"action": "refuse"}));
    }
    let skipped = password
        || role == "chrome"
        || (!in_page && (role == "control" || role == "toolbar"))
        || outside(at, window);
    let shown = !hidden && shown_box(at, thin);
    let mut step = if skipped {
        json!({"action": "skip"})
    } else if part {
        // Inside a heading, link or row: its text, fields and a page's control captions; a box
        // that shows nothing is not gone into.
        match role {
            _ if !shown => json!({"action": "skip"}),
            "text" | "field" => json!({"action": role}),
            "control" => json!({"action": "caption", "shown": true}),
            _ => descend,
        }
    } else {
        // A box that shows nothing has no text of its own read, but is walked into (owner,
        // 2026-10-05): Slack keeps its message list in one.
        match role {
            "page" => json!({"action": "descend", "childrenInPage": true, "host": true}),
            "text" | "field" if shown => json!({"action": role}),
            "heading" | "link" | "row" if shown => json!({"action": "semantic", "kind": role}),
            "listItem" if !in_page && shown => json!({"action": "semantic", "kind": "row"}),
            "text" | "field" | "heading" | "link" | "row" => json!({"action": "skip"}),
            "listItem" if !in_page => json!({"action": "skip"}),
            "control" => json!({"action": "caption", "shown": shown}),
            _ => descend,
        }
    };
    if caret_first {
        step["caretFirst"] = json!(true);
    }
    Ok(step)
}

/// `{"look": {"read": action, "found": "none" | "excluded" | "notSeenWhole"}}`: what a look inside
/// an element read in one piece found decides its read. An excluded page refuses the window,
/// except in a field (read by its value, never walked into), which the marker stands in for; a
/// look that ran out of budget before seeing the element whole withholds it behind the marker
/// (owner, 2026-10-05). `outcome`: `read`, `refuse` or `marker`.
fn look(request: &Value) -> Result<Value, u32> {
    let read = request.get("read").and_then(Value::as_str).ok_or(1u32)?;
    if !["text", "field", "semantic", "caption"].contains(&read) {
        return Err(1);
    }
    let outcome = match request.get("found").and_then(Value::as_str).ok_or(1u32)? {
        "none" => "read",
        "excluded" if read == "field" => "marker",
        "excluded" => "refuse",
        "notSeenWhole" => "marker",
        _ => return Err(1),
    };
    Ok(json!({"outcome": outcome}))
}

/// `{"census": {"visited": n, "queued": m, "late": bool, "page": null | "excluded" | "allowed",
/// "intoPages": bool, "password": bool}}`: one step of a look inside an element for an excluded
/// page, at the element taken next, with `n` elements visited before it and `m` still waiting.
/// `step`: `notSeenWhole` (more elements than the budget, or out of time: the look gives up),
/// `excluded`, `skip` (a password element, whose children a helper never asks for, or a page not
/// excluded, not looked into without `intoPages`) or `descend`, fetching at most `children` of its
/// children (one more than fits, so a look that overflows says so).
/// With `"start": true` the step is the look's first, at the element looked inside itself: it is
/// not counted (no `visited` or `queued`), and is judged only by the facts sent about it.
fn census(request: &Value) -> Result<Value, u32> {
    let start = flag(request, "start")?;
    let (visited, queued) = if start {
        if request.get("visited").is_some() || request.get("queued").is_some() {
            return Err(1);
        }
        (0, 0)
    } else {
        (number(request, "visited")?, number(request, "queued")?)
    };
    let known = visited
        .checked_add(queued)
        .and_then(|known| known.checked_add(u64::from(!start)))
        .ok_or(1u32)?;
    let late = flag(request, "late")?;
    let into_pages = flag(request, "intoPages")?;
    let password = flag(request, "password")?;
    let page = match request.get("page") {
        None | Some(Value::Null) => None,
        Some(Value::String(page)) if page == "excluded" || page == "allowed" => Some(page.as_str()),
        Some(_) => return Err(1),
    };
    Ok(match page {
        _ if late || known > NODE_BUDGET => json!({"step": "notSeenWhole"}),
        _ if password => json!({"step": "skip"}),
        Some("excluded") => json!({"step": "excluded"}),
        Some(_) if !into_pages => json!({"step": "skip"}),
        _ => json!({"step": "descend", "children": NODE_BUDGET + 1 - known}),
    })
}

/// `{"stop": {"nodes": n, "elapsed": ms, "textFull": bool}}`: why the walk stops before the next
/// element, or null to go on: `text budget` (the screen's text is full), `node budget`, `time budget`.
fn stop(request: &Value) -> Result<Value, u32> {
    let reason = if flag(request, "textFull")? {
        Some("text budget")
    } else if number(request, "nodes")? >= NODE_BUDGET {
        Some("node budget")
    } else if number(request, "elapsed")? > TIME_BUDGET_MILLISECONDS {
        Some("time budget")
    } else {
        None
    };
    Ok(json!({"stopped": reason}))
}

pub(crate) fn process(bytes: &[u8]) -> Result<Vec<u8>, u32> {
    let input: Value = serde_json::from_slice(bytes).map_err(|_| 1u32)?;
    let object = input
        .as_object()
        .filter(|object| object.len() == 1)
        .ok_or(1u32)?;
    let reply = match object.iter().next().ok_or(1u32)? {
        (name, Value::Bool(true)) if name == "limits" => json!({
            "nodeBudget": NODE_BUDGET,
            "timeBudgetMilliseconds": TIME_BUDGET_MILLISECONDS,
            "focusDepth": FOCUS_DEPTH,
        }),
        (name, value) if name == "node" => node(value)?,
        (name, value) if name == "look" => look(value)?,
        (name, value) if name == "census" => census(value)?,
        (name, value) if name == "stop" => stop(value)?,
        _ => return Err(1),
    };
    serde_json::to_vec(&reply).map_err(|_| 3)
}

#[cfg(test)]
mod tests;
