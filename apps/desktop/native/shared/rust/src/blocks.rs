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
//!
//! - `{"start": {"elements": n}}`: a walk placing at most `n` elements.
//! - `{"state": S, "children": count}`: the children of the element last asked for.
//! - `{"state": S, "placed": facts | null}`: the element last asked to be placed, null when it has
//!   no place. Its `block`, and only what the ask's `phase` needs (each a comparison the OS makes
//!   across processes): while `halve`, `endsBefore` (it ends before the window's start); while
//!   `scan`, `startsPast` (it starts after the window's end) and `startsWithin` (it starts at or
//!   after the window's start).
//!
//! Each reply is `{"state", "ask", "start"}`, or `{"done": complete, "start"}` at the end:
//! `start` says the element just placed starts a line, and `ask` is `{"children": {"depth",
//! "child"}}` (the children of that child of the element at that depth of the walk; depth null for
//! the field itself) or `{"place": {"depth", "child", "phase"}}`. A walk that is not complete gives no starts.
//!
//! `{"endsLine": {"startsBefore", "reachesSelection"}}` → `{"endsLine": bool}`: a selection whose
//! start is in an element starting before it and reaching it is at the end of that element's
//! line, not at the start of the block after it (the text gives both places one offset; measured
//! in Chromium, 2026-10-06).

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
}

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
            "asked": {"child": self.asked.0, "children": self.asked.1}})
    }

    /// The next element to ask about, or the end.
    fn advance(&mut self, start: bool) -> Value {
        loop {
            let Some(frame) = self.stack.last_mut() else {
                return json!({"done": true, "start": start});
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
                return json!({"done": false, "start": start});
            }
            let depth = self.stack.len() - 1;
            self.asked = (child, false);
            return json!({"state": self.state(), "ask": {"place": {"depth": depth, "child": child,
                "phase": phase}}, "start": start});
        }
    }

    fn placed(&mut self, facts: &Value) -> Result<Value, u32> {
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
        };
        return Ok(
            json!({"state": walk.state(), "ask": {"children": {"depth": null, "child": 0}},
            "start": false}),
        );
    }
    if let Some(line) = input.get("endsLine") {
        if fields.len() != 1 {
            return Err(1);
        }
        return Ok(
            json!({"endsLine": flag(&line["startsBefore"])? && flag(&line["reachesSelection"])?}),
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
