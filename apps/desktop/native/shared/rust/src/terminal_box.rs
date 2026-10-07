// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The box around a terminal's cursor, cut from the projected viewport (`viewport::process`), whose
//! text is already redacted (ADR-DESK-054): the cursor's row and the rows above and below it that
//! share its pane, between the nearest borders on each side of the cursor (tmux's pane borders, the
//! sides a full-screen program draws around its input) and up to a horizontal rule (tmux's border
//! between panes one above the other, the rules above and below Claude Code's input). The screen
//! read's caret window takes the cursor's row (`before` and `after`), so a dictation is spaced from
//! a delimiter before the cursor; the field read for correction learning takes the whole box, so a
//! dictation the terminal wrapped is found whole. Only a caret the projection
//! placed exactly gets a box. The cut is by character column: a row holding a double-width
//! character has its borders a column early, which stops the box there rather than reading another
//! pane.

use serde_json::Value;

/// A character drawn as a border or rule: Unicode's box drawing block.
fn is_border(character: char) -> bool {
    ('\u{2500}'..='\u{257F}').contains(&character)
}

/// The box around the cursor: the rows above it, the cursor's row before and after the cursor, and
/// the rows below it, each the part between the cursor's borders, trailing blanks dropped (the
/// cursor row's part before the cursor keeps them: a space typed before the cursor is the user's).
#[derive(Debug, PartialEq)]
pub(crate) struct CaretBox {
    pub above: Vec<String>,
    pub before: String,
    pub after: String,
    pub below: Vec<String>,
}

/// `text` up to `units` UTF-16 code units, as a byte offset; none inside a character.
fn byte_at(text: &str, units: usize) -> Option<usize> {
    let mut counted = 0;
    for (byte, character) in text.char_indices() {
        if counted == units {
            return Some(byte);
        }
        counted += character.len_utf16();
    }
    (counted == units).then_some(text.len())
}

/// The box around the exact caret of `projected`, a viewport projection's output; none without an
/// exact caret, or one the projection's runs do not hold.
pub(crate) fn caret_box(projected: &Value) -> Option<CaretBox> {
    let caret = &projected["caret"];
    if caret["status"] != "exact" {
        return None;
    }
    let surface = projected["surfaces"]
        .as_array()?
        .iter()
        .find(|surface| surface["id"] == caret["surface"])?;
    let runs = surface["runs"].as_array()?;
    let index = runs.iter().position(|run| run["id"] == caret["run"])?;
    // The runs read in one piece with the caret's: the text on either side of it, as on screen.
    let mut first = index;
    while first > 0 && runs[first]["connected"] == true {
        first -= 1;
    }
    let mut end = index + 1;
    while end < runs.len() && runs[end]["connected"] == true {
        end += 1;
    }
    let mut text = String::new();
    let mut at = None;
    for (position, run) in runs.iter().enumerate().take(end).skip(first) {
        let run_text = run["text"].as_str()?;
        if position == index {
            let offset = usize::try_from(caret["offset"].as_u64()?).ok()?;
            at = Some(text.len() + byte_at(run_text, offset)?);
        }
        text.push_str(run_text);
    }
    let at = at?;
    // Rows as drawn; a CRLF ends a row as a line break does.
    let rows: Vec<Vec<char>> = text
        .split('\n')
        .map(|row| row.strip_suffix('\r').unwrap_or(row).chars().collect())
        .collect();
    let row_start = text[..at].rfind('\n').map_or(0, |found| found + 1);
    let caret_row = text[..row_start].matches('\n').count();
    let row = &rows[caret_row];
    let column = text[row_start..at].chars().count().min(row.len());
    let left = (0..column).rev().find(|&i| is_border(row[i]));
    let right = (column..row.len()).find(|&i| is_border(row[i]));
    let from = left.map_or(0, |left| left + 1);
    let part = |row: &[char], start: usize, stop: usize| -> String {
        row[start.min(row.len())..stop.min(row.len())]
            .iter()
            .collect()
    };
    // Another row is in the box while the cursor's borders are borders there too, until a rule.
    let boxed = |row: &Vec<char>| -> Option<String> {
        if left.is_some_and(|left| !row.get(left).copied().is_some_and(is_border))
            || right.is_some_and(|right| !row.get(right).copied().is_some_and(is_border))
        {
            return None;
        }
        let kept = part(row, from, right.unwrap_or(row.len()))
            .trim_end()
            .to_owned();
        let rule = kept.chars().any(is_border)
            && kept
                .chars()
                .all(|character| character.is_whitespace() || is_border(character));
        (!rule).then_some(kept)
    };
    let mut above: Vec<String> = rows[..caret_row].iter().rev().map_while(boxed).collect();
    above.reverse();
    let below = rows[caret_row + 1..].iter().map_while(boxed).collect();
    Some(CaretBox {
        above,
        before: part(row, from, column),
        after: part(row, column, right.unwrap_or(row.len()))
            .trim_end()
            .to_owned(),
        below,
    })
}

#[cfg(test)]
mod tests;
