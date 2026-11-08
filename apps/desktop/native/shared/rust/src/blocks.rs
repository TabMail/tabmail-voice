// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Where a Chromium rich editor starts its blocks near the selection, for the Mac and Windows
//! (ADR-DESK-007, 2026-10-06; ADR-DESK-054). Its text leaves out the break before a block that
//! starts right after text (each <div>), and the caret window puts those back. The helper walks
//! the field's elements and says what the OS tells it about each one placed in the text; this core
//! decides which to place, which start a line, and when the walk ends. In each element's children
//! the first that ends at or after the window's start is found by halving (a long field costs a
//! few looks), then each in turn until one starts past the window's end, going into each block.
//! A block starts a line, and so does what follows one; only starts within the window count.
//! When that walk runs out of budget, a second walks the selection alone (the window `caret`: its own ends, a few looks per level) on a small budget of
//! its own, so the starts at the caret, which decide where a dictation goes, are still found: a
//! code editor gives each highlighted piece of a line its own element, more than the budget holds
//! in the window (Overleaf in Firefox, 481 elements in 30 lines, 2026-11-05, #355). A window the
//! budget holds is walked as before, and its starts are all kept. An element with no place ends
//! either walk with no starts, as before: the OS misplaced something, and a start kept then could
//! fall inside a line, and inside a secret on it (ADR-DESK-046).
//!
//! - `{"start": {"elements": n}}`: a walk placing at most `n` elements.
//! - `{"state": S, "children": count}`: the children of the element last asked for.
//! - `{"state": S, "placed": facts | null}`: the element last asked to be placed, null when it has
//!   no place. Its `block`, and only what the ask's `phase` needs (each a comparison the OS makes
//!   across processes): while `halve`, `endsBefore` (it ends before the window's start); while
//!   `scan`, `startsPast` (it starts after the window's end) and `startsWithin` (it starts at or
//!   after the window's start).
//!
//! Each reply is `{"state", "ask", "start"}`, or `{"done": complete, "starts"?, "start"}` at the
//! end: `start` says the element just placed starts a line, and `ask` is `{"children": {"depth",
//! "child"}}` (the children of that child of the element at that depth of the walk; depth null for
//! the field itself, which also begins the selection's walk) or `{"place": {"depth", "child",
//! "phase", "window"}}`, the facts compared with that window's ends (`shown`: the window's;
//! `caret`: the selection's). A complete walk names whose starts to keep (`starts`: `shown` or
//! `caret`; the helper keeps each start with the window of the ask that placed it); one that is not
//! complete gives no starts.
//!
//! `{"endsLine": {"startsBefore", "reachesSelection", "caret"?, "before"?}}` → `{"endsLine": bool}`:
//! a selection whose start is in an element starting before it and reaching it is at the end of
//! that element's line, not at the start of the block after it (the text gives both places one
//! offset; measured in Chromium, 2026-10-06). Unless the screen says otherwise: `caret` and
//! `before` are where a collapsed caret and the character before it are drawn (`{x, y, width,
//! height}`, y growing down, from the OS), and a caret drawn left of that character's middle, or
//! below it, is not right after it, so it starts its line. Gecko puts the marker of a caret on an
//! empty line in the line above's last element, and draws that caret at the line's start
//! (Overleaf's code editor in Firefox on the Mac, 2026-11-05; Windows and Linux give that caret
//! its own line's place). Without both rectangles, or with one of no height (no place on screen),
//! the element decides alone.
//!
//! `{"caretLine": {"caret", "drawn"?}}` → `{"caretLine": rect}`: the line a collapsed caret is on.
//! Gecko draws a caret at a line's start, or on an empty line, over that line and the one above it
//! (`caret`: Firefox's CodeMirror page on Windows, the same rectangle from UI Automation's caret
//! range and from the system caret, its top the line above's and its bottom its own line's;
//! measured 2026-11-08, #380). `drawn` is what the screen has just above the caret's bottom (the
//! character there, or the empty line's place). When it starts inside the caret, at least
//! `LINE_ABOVE_SHARE` of its own height below the caret's top (room for a line above it), and is
//! shorter than the caret, the caret is on its line: its top and height, with the caret's x and
//! width. Otherwise, or without it, the caret is where it is drawn: a caret on one line has what
//! is drawn at its bottom at about its own top.

use serde_json::{Value, json};

fn number(value: &Value) -> Result<usize, u32> {
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(1)
}
fn flag(value: &Value) -> Result<bool, u32> {
    value.as_bool().ok_or(1)
}

/// How far below a caret's top what is drawn at its bottom must start, as a share of its own
/// height, for the caret to cover a line above it (`caretLine`): a caret on one line is at most a
/// few pixels taller than its text, and one covering two is a line taller.
const LINE_ABOVE_SHARE: f64 = 0.5;

/// Where something is drawn on screen.
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// A rectangle the helper sent, none when it sent none or one of no height (no place on screen).
fn drawn(value: Option<&Value>) -> Result<Option<Rect>, u32> {
    let Some(value) = value else { return Ok(None) };
    let number = |key: &str| value[key].as_f64().ok_or(1u32);
    let rect = Rect {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?,
        height: number("height")?,
    };
    Ok((rect.height > 0.0).then_some(rect))
}

/// One element whose children are being walked: their count, the halving's bounds, the child
/// being scanned once the halving is done, whether the one before it is a block, and whether the
/// last child the halving went past is one.
struct Frame {
    count: usize,
    lower: usize,
    upper: usize,
    scan: Option<usize>,
    after_block: bool,
    lower_block: bool,
}

struct Walk {
    elements: usize,
    looks: usize,
    stack: Vec<Frame>,
    /// The child last asked about, and whether for its children (else its place).
    asked: (usize, bool),
    /// Whether this is the selection's walk, after the window's did not end.
    caret: bool,
}

/// The most elements the selection's walk places: a few looks for each level of the field the
/// selection is in (halving each element's children down to it), more than a collapsed caret
/// needs in the deepest editor measured. A selection over more ends with no starts, as before.
const SELECTION_ELEMENTS: usize = 64;

impl Walk {
    fn read(state: &Value) -> Result<Self, u32> {
        let mut stack = Vec::new();
        for frame in state["stack"].as_array().ok_or(1u32)? {
            let frame = Frame {
                count: number(&frame["count"])?,
                lower: number(&frame["lower"])?,
                upper: number(&frame["upper"])?,
                scan: match &frame["scan"] {
                    Value::Null => None,
                    value => Some(number(value)?),
                },
                after_block: flag(&frame["afterBlock"])?,
                lower_block: flag(&frame["lowerBlock"])?,
            };
            if frame.lower > frame.upper
                || frame.upper > frame.count
                || frame.scan.is_some_and(|scan| scan > frame.count)
            {
                return Err(1);
            }
            stack.push(frame);
        }
        let walk = Walk {
            elements: number(&state["elements"])?,
            looks: number(&state["looks"])?,
            stack,
            asked: (
                number(&state["asked"]["child"])?,
                flag(&state["asked"]["children"])?,
            ),
            caret: match state["window"].as_str() {
                Some("shown") => false,
                Some("caret") => true,
                _ => return Err(1),
            },
        };
        if walk.looks > walk.elements || walk.stack.len() > walk.elements + 1 {
            return Err(1);
        }
        Ok(walk)
    }

    fn state(&self) -> Value {
        let stack: Vec<Value> = self
            .stack
            .iter()
            .map(|frame| {
                json!({"count": frame.count, "lower": frame.lower, "upper": frame.upper,
                    "scan": frame.scan, "afterBlock": frame.after_block, "lowerBlock": frame.lower_block})
            })
            .collect();
        json!({"elements": self.elements, "looks": self.looks, "stack": stack,
            "asked": {"child": self.asked.0, "children": self.asked.1}, "window": self.window()})
    }

    fn window(&self) -> &'static str {
        if self.caret { "caret" } else { "shown" }
    }

    /// The end of a walk. The window's: complete, its starts; out of budget, the selection's walk
    /// begins from the field, on its own budget. The selection's: complete, its starts; out of
    /// budget, none.
    fn end(&mut self, complete: bool, start: bool) -> Value {
        match (self.caret, complete) {
            (false, true) => json!({"done": true, "starts": "shown", "start": start}),
            (false, false) => {
                self.caret = true;
                self.elements = self.elements.min(SELECTION_ELEMENTS);
                self.looks = 0;
                self.stack.clear();
                self.asked = (0, true);
                json!({"state": self.state(), "ask": {"children": {"depth": null, "child": 0}},
                    "start": start})
            }
            (true, true) => json!({"done": true, "starts": "caret", "start": start}),
            (true, false) => json!({"done": false, "start": start}),
        }
    }

    /// The next element to ask about, or the end.
    fn advance(&mut self, start: bool) -> Value {
        loop {
            let Some(frame) = self.stack.last_mut() else {
                return self.end(true, start);
            };
            let child = match frame.scan {
                None if frame.lower < frame.upper => (frame.lower + frame.upper) / 2,
                None => {
                    frame.after_block = frame.lower > 0 && frame.lower_block;
                    frame.scan = Some(frame.lower);
                    continue;
                }
                Some(index) if index >= frame.count => {
                    self.stack.pop();
                    continue;
                }
                Some(index) => index,
            };
            let phase = if frame.scan.is_some() {
                "scan"
            } else {
                "halve"
            };
            self.looks += 1;
            if self.looks > self.elements {
                return self.end(false, start);
            }
            let depth = self.stack.len() - 1;
            self.asked = (child, false);
            return json!({"state": self.state(), "ask": {"place": {"depth": depth, "child": child,
                "phase": phase, "window": self.window()}}, "start": start});
        }
    }

    fn placed(&mut self, facts: &Value) -> Result<Value, u32> {
        // An element with no place: no starts from either walk.
        if facts.is_null() {
            return Ok(json!({"done": false, "start": false}));
        }
        let block = flag(&facts["block"])?;
        let (child, children) = self.asked;
        let frame = self.stack.last_mut().ok_or(1u32)?;
        if children {
            return Err(1);
        }
        match frame.scan {
            None => {
                if child != (frame.lower + frame.upper) / 2 || frame.lower >= frame.upper {
                    return Err(1);
                }
                if flag(&facts["endsBefore"])? {
                    frame.lower = child + 1;
                    frame.lower_block = block;
                } else {
                    frame.upper = child;
                }
                Ok(self.advance(false))
            }
            Some(index) => {
                if child != index {
                    return Err(1);
                }
                if flag(&facts["startsPast"])? {
                    self.stack.pop();
                    return Ok(self.advance(false));
                }
                let start = (block || frame.after_block) && flag(&facts["startsWithin"])?;
                frame.after_block = block;
                frame.scan = Some(index + 1);
                if !block {
                    return Ok(self.advance(start));
                }
                self.asked = (child, true);
                let depth = self.stack.len() - 1;
                Ok(
                    json!({"state": self.state(), "ask": {"children": {"depth": depth, "child": child}},
                    "start": start}),
                )
            }
        }
    }

    fn children(&mut self, count: usize) -> Result<Value, u32> {
        if !self.asked.1 {
            return Err(1);
        }
        self.stack.push(Frame {
            count,
            lower: 0,
            upper: count,
            scan: None,
            after_block: false,
            lower_block: false,
        });
        Ok(self.advance(false))
    }
}

pub(crate) fn process(input: &Value) -> Result<Value, u32> {
    let fields = input.as_object().ok_or(1u32)?;
    if let Some(start) = input.get("start") {
        if fields.len() != 1 {
            return Err(1);
        }
        let walk = Walk {
            elements: number(&start["elements"])?,
            looks: 0,
            stack: Vec::new(),
            asked: (0, true),
            caret: false,
        };
        return Ok(
            json!({"state": walk.state(), "ask": {"children": {"depth": null, "child": 0}},
            "start": false}),
        );
    }
    if let Some(line) = input.get("caretLine") {
        if fields.len() != 1 {
            return Err(1);
        }
        let caret = drawn(line.get("caret"))?.ok_or(1u32)?;
        let place = match drawn(line.get("drawn"))? {
            Some(below)
                if below.height < caret.height
                    && below.y >= caret.y + below.height * LINE_ABOVE_SHARE
                    && below.y < caret.y + caret.height =>
            {
                Rect {
                    y: below.y,
                    height: below.height,
                    ..caret
                }
            }
            _ => caret,
        };
        return Ok(
            json!({"caretLine": {"x": place.x, "y": place.y, "width": place.width, "height": place.height}}),
        );
    }
    if let Some(line) = input.get("endsLine") {
        if fields.len() != 1 {
            return Err(1);
        }
        let caret = drawn(line.get("caret"))?;
        let before = drawn(line.get("before"))?;
        let follows = match (caret, before) {
            (Some(caret), Some(before)) => {
                caret.x >= before.x + before.width / 2.0 && caret.y < before.y + before.height
            }
            _ => true,
        };
        return Ok(
            json!({"endsLine": flag(&line["startsBefore"])? && flag(&line["reachesSelection"])? && follows}),
        );
    }
    if fields.len() != 2 {
        return Err(1);
    }
    let mut walk = Walk::read(&input["state"])?;
    if let Some(count) = input.get("children") {
        walk.children(number(count)?)
    } else if let Some(facts) = input.get("placed") {
        walk.placed(facts)
    } else {
        Err(1)
    }
}

#[cfg(test)]
mod tests;
