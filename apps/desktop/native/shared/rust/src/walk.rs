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

/// The most elements one walk, or one look inside an element, visits: a count that only ends a
/// walk through an endless or looping tree, since a desktop reads the whole window, in memory, in
/// a process of its own (owner, 2026-10-25).
const NODE_BUDGET: u64 = 100_000;
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

/// The thickest a box can be, in points, and still show no text of its own (owner, 2026-10-05).
const HIDDEN_MAX_POINTS: f64 = 1.0;

/// Whether a box can show its own text: one at most `thin` across either way shows nothing
/// (screen-reader-only labels, elements scrolled out of view, hover-only actions); one that
/// reports no size (0×0) says nothing and counts as shown (owner, 2026-10-05). A terminal's
/// surface is read only when shown; elsewhere such a box's text is read, unplaced.
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

/// The thickest box that shows nothing, in the frames' units: `scale` of them make a point.
fn thin(facts: &Value) -> Result<f64, u32> {
    Ok(facts
        .get("scale")
        .and_then(Value::as_f64)
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .ok_or(1u32)?
        * HIDDEN_MAX_POINTS)
}

/// `{"shown": {"frame", "window", "scale", "hidden"}}` → `{"shown": bool}`: whether an element read
/// outside the walk (a terminal's surface) shows anything, by the walk's rule: not hidden, not
/// wholly outside the window, and no thinner than a point.
fn shown(facts: &Value) -> Result<Value, u32> {
    if !facts.is_object() {
        return Err(1);
    }
    let at = frame(facts, "frame")?;
    let shown = !flag(facts, "hidden")?
        && !outside(at, frame(facts, "window")?)
        && shown_box(at, thin(facts)?);
    Ok(json!({"shown": shown}))
}

/// `{"node": {...}}`: what to do with one element. `role` is from the module's list; `focus` is
/// `"self"` (the focused element), `"path"` (one of its ancestors) or absent; `part` is true
/// inside a heading, link or row being read in one piece. The flags `inPage`, `password`,
/// `pageExcluded` (a page whose site is excluded), `focusedField` (the focus is a field, read by
/// the caret), `selection` (the focus has a selection), `hidden` (the OS says the element is
/// not drawn), `offscreen` (the OS says it is drawn but out of view) and `wholeWindow` (the read
/// takes the whole window) default to false; `frame` and `window` are `[x, y, width, height]` or
/// null; `scale` is how many of the frames' units make a point (the display's DPI scale on
/// Windows, else 1).
///
/// Two reads, by `wholeWindow` (owner, 2026-10-25): without it, what the window shows (an element
/// wholly outside the window, `offscreen`, or in a box at most a point thin is not read: what
/// dictation and the agent's screen text take); with it, everything the accessibility tree holds,
/// on screen or not, as a screen reader reads it (the agent's `screen_read`, and dictation's terms
/// when there is room): only what is not drawn at all (`hidden`) is not.
///
/// The reply's `action`: `refuse` (the window shows an excluded page: nothing of it is used),
/// `skip` (with `look`, a hidden element: look inside it first, as for that read, and refuse the
/// window on `refuse`), `caret` (the focused field, as what the window shows takes it: the caret block goes here), `descend` (walk into it, its
/// children inside a page when `childrenInPage`), `text`, `field`, `semantic` (a heading, link or
/// row of `kind`, from its label and what it holds) or `caption` (a page's control: its drawn
/// caption, or, having none, walk into it; when not `shown` a control with a caption is looked
/// inside, then skipped).
/// `caretFirst`: the caret block goes before it: the focus's selection, or, reading the whole
/// window, the mark of the focused field. `host`: the walk's page host is this
/// page's, unless it has one already. `unplaced`: the element's frame, a box at most a point
/// thin, says nothing of where its text is, so the helper gives the read no frame for it. Every
/// read in one piece looks inside the element for an excluded page first (`look`).
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
    let offscreen = flag(facts, "offscreen")?;
    let whole_window = flag(facts, "wholeWindow")?;
    let at = frame(facts, "frame")?;
    // Where the element is decides whether it is read only when the read takes what the window
    // shows.
    let outside = !whole_window && outside(at, frame(facts, "window")?);
    let thin = thin(facts)?;
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
            // What the window shows takes the focused field by the text around its caret. The
            // whole window reads it whole, like any field or page, after the caret block, which
            // only marks it: none of the caret's text is kept as well (`around`). A password
            // field is never read: in either read it is only the caret block, which the helper
            // places as for one (no frame).
            if focused_field && (!whole_window || password) {
                return Ok(json!({"action": "caret"}));
            }
            caret_first = selection || focused_field;
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
    // An excluded page wholly outside the window is skipped with what it holds, like any other
    // element there, when the read takes what the window shows; one the window may show refuses
    // it (ADR-DESK-047, 2026-10-01). Reading the whole window, it refuses the window wherever it
    // is: scrolled out of view, it would be read like the rest (amended 2026-10-25).
    if excluded && !outside {
        return Ok(json!({"action": "refuse"}));
    }
    let skipped = password
        || role == "chrome"
        || (!in_page && (role == "control" || role == "toolbar"))
        || outside;
    // What the window shows: not hidden, not out of view, in a box more than a point thick. The
    // whole window: everything but what the OS says is not drawn at all.
    let shown = !hidden && (whole_window || (!offscreen && shown_box(at, thin)));
    // An element that shows nothing is skipped, but only once a look inside it has found no
    // excluded page (`look`: the read its look stands for): a page under a hidden row or panel
    // may still be on screen, and refuses the window (ADR-DESK-047).
    let hidden_skip =
        || json!({"action": "skip", "look": if role == "field" { "field" } else { "text" }});
    let mut step = if skipped {
        json!({"action": "skip"})
    } else if part {
        // Inside a heading, link or row: its text, fields and a page's control captions; an
        // element that shows nothing is not gone into.
        match role {
            _ if !shown => hidden_skip(),
            "text" | "field" => json!({"action": role}),
            "control" => json!({"action": "caption", "shown": true}),
            _ => descend,
        }
    } else {
        // An element that shows nothing has no text of its own read, but is walked into (owner,
        // 2026-10-05): Slack keeps its message list in one.
        match role {
            "page" => json!({"action": "descend", "childrenInPage": true, "host": true}),
            "text" | "field" if shown => json!({"action": role}),
            "heading" | "link" | "row" if shown => json!({"action": "semantic", "kind": role}),
            "listItem" if !in_page && shown => json!({"action": "semantic", "kind": "row"}),
            "text" | "field" | "heading" | "link" | "row" => hidden_skip(),
            "listItem" if !in_page => hidden_skip(),
            "control" => json!({"action": "caption", "shown": shown}),
            _ => descend,
        }
    };
    // What a helper may still walk into after reading it (a page's control with no caption, a
    // piece of text with no name, a field not shown safe) keeps the page it is in.
    if matches!(step["action"].as_str(), Some("text" | "field" | "caption")) {
        step["childrenInPage"] = json!(children_in_page);
    }
    // Reading the whole window, a box at most a point thin says nothing of where its text is:
    // Chromium squashes every element scrolled out of view to such a sliver at the edge of what
    // holds it, all at one place, and screen-reader-only labels are drawn so. Its text is read
    // where the walk meets it, but its frame is not laid out from (`unplaced`: the helper gives it
    // no frame), so it starts a line of its own rather than joining a neighbour as if beside it.
    if whole_window
        && matches!(
            step["action"].as_str(),
            Some("text" | "field" | "caption" | "semantic")
        )
        && !shown_box(at, thin)
    {
        step["unplaced"] = json!(true);
    }
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

/// `{"census": {"visited": n, "late": bool, "page": null | "excluded" | "allowed", "intoPages":
/// bool, "password": bool}}`: one step of a look inside an element for an excluded page, at the
/// element taken next, with `n` elements visited before it. `step`: `notSeenWhole` (the budget's
/// elements are visited, or out of time: the look gives up), `excluded`, `skip` (a password
/// element, whose children a helper never asks for, or a page not excluded, not looked into
/// without `intoPages`) or `descend`, fetching at most `children` of its children: one more than
/// the visits left, so a look given more than it can visit ends at the budget, not seen whole.
/// Only visits count: what waits may never be visited, as a look goes deep first (the elements
/// last fetched first), and one that holds an excluded page refuses before the budget runs out.
/// With `"start": true` the step is the look's first, at the element looked inside itself: it is
/// not counted (no `visited`), and is judged only by the facts sent about it.
/// With `"protect": true` the look is for a part whose text gathers its descendants' (a terminal's
/// surface, a name or caption read whole): a password element anywhere in it, the element itself
/// included, refuses it (`protected`), as an excluded page does, and the element itself counts
/// against the budget, since its text is read with everything under it.
fn census(request: &Value) -> Result<Value, u32> {
    let start = flag(request, "start")?;
    let visited = if start {
        if request.get("visited").is_some() {
            return Err(1);
        }
        0
    } else {
        number(request, "visited")?
    };
    let late = flag(request, "late")?;
    let into_pages = flag(request, "intoPages")?;
    let password = flag(request, "password")?;
    let protect = flag(request, "protect")?;
    let visited = visited + u64::from(protect);
    let page = match request.get("page") {
        None | Some(Value::Null) => None,
        Some(Value::String(page)) if page == "excluded" || page == "allowed" => Some(page.as_str()),
        Some(_) => return Err(1),
    };
    Ok(match page {
        _ if late || visited >= NODE_BUDGET => json!({"step": "notSeenWhole"}),
        _ if password && protect => json!({"step": "protected"}),
        _ if password => json!({"step": "skip"}),
        Some("excluded") => json!({"step": "excluded"}),
        Some(_) if !into_pages => json!({"step": "skip"}),
        // The visits left after this element (the start is not counted), and one more.
        _ => json!({"step": "descend", "children": NODE_BUDGET - visited - u64::from(!start) + 1}),
    })
}

/// `{"around": {"focusedField": bool, "wholeWindow": bool}}`: what the read keeps of the caret's
/// text: the text around the caret (`around`) and what is selected (`selection`). Only a field in
/// focus has text around a caret of its own (a page clicked on, a list or a row is read by the walk
/// as it is laid out, and keeps only its selection), and only what the window shows takes the field
/// by it. The whole window keeps neither: it reads the field whole (`node`), where its text is
/// redacted with what surrounds it, and the caret block only marks it. A selection kept apart from
/// the text around it would lose what a redactor needs to know it (a `token=` before a selected
/// value), so the whole read carries no copy of it (round-5 review, 2026-10-26).
fn around(request: &Value) -> Result<Value, u32> {
    if !request.is_object() {
        return Err(1);
    }
    let whole_window = flag(request, "wholeWindow")?;
    Ok(json!({
        "around": flag(request, "focusedField")? && !whole_window,
        "selection": !whole_window,
    }))
}

/// `{"stop": {"nodes": n, "textFull": bool, "asked": bool}}`: why the walk stops before the next
/// element, or null to go on: `asked` (the app asked for what is read so far), `text budget` (the
/// screen's text is full) or `node budget`. A walk has no time limit: it runs while the user
/// speaks, and when the app stops waiting it asks the reader to stop, and takes what the walk has
/// gathered, laid out and redacted as any read is (owner, 2026-10-25).
fn stop(request: &Value) -> Result<Value, u32> {
    let reason = if flag(request, "asked")? {
        Some("asked")
    } else if flag(request, "textFull")? {
        Some("text budget")
    } else if number(request, "nodes")? >= NODE_BUDGET {
        Some("node budget")
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
            "focusDepth": FOCUS_DEPTH,
        }),
        (name, value) if name == "node" => node(value)?,
        (name, value) if name == "look" => look(value)?,
        (name, value) if name == "census" => census(value)?,
        (name, value) if name == "stop" => stop(value)?,
        (name, value) if name == "shown" => shown(value)?,
        (name, value) if name == "around" => around(value)?,
        _ => return Err(1),
    };
    serde_json::to_vec(&reply).map_err(|_| 3)
}

#[cfg(test)]
mod tests;
