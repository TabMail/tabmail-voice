// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

mod definitions;
mod scan;

use definitions::Redactor;
use scan::Found;
use std::ops::Range;
use std::sync::OnceLock;

pub type Lines = Vec<Vec<String>>;
pub const PLACEHOLDER: &str = "[redacted]";
const DEFINITIONS: &str = include_str!("../../privacy/redactors.json");

/// Errors contain no captured text or engine diagnostic payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidDefinitions,
    InvalidBoundary,
}

fn redactors() -> Result<&'static [Redactor], Error> {
    static REDACTORS: OnceLock<Result<Vec<Redactor>, Error>> = OnceLock::new();
    REDACTORS
        .get_or_init(|| definitions::parse(DEFINITIONS))
        .as_deref()
        .map_err(|e| *e)
}

/// What the finds take out of the text, in order: each run is finds that overlap or meet, and
/// one marker stands for it.
fn runs(found: &[Found]) -> Vec<Range<usize>> {
    let mut taken: Vec<Range<usize>> = found
        .iter()
        .map(|f| f.taken.clone())
        .filter(|range| !range.is_empty())
        .collect();
    taken.sort_by_key(|range| range.start);
    let mut runs: Vec<Range<usize>> = Vec::new();
    for range in taken {
        match runs.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => runs.push(range),
        }
    }
    runs
}

/// What the redaction takes out of one text: byte ranges in order, each one marker's worth (a
/// match, or several that overlap or meet). Each range starts and ends on a character boundary.
pub fn taken(text: &str) -> Result<Vec<Range<usize>>, Error> {
    taken_with_edges(text, &[])
}

/// As `taken`, for a text made of pieces the screen shows on their own (a link, a bold run):
/// `edges` are the byte offsets, ascending, where such a piece starts. A key's prefix at one has
/// its word edge; an edge never ends a find.
pub fn taken_with_edges(text: &str, edges: &[usize]) -> Result<Vec<Range<usize>>, Error> {
    Ok(runs(&scan::scan(text, edges, redactors()?)))
}

/// Redact the combined text before redistributing it across line/caret boundaries.
/// Only the immutable definitions are cached; the text and its finds belong to this call.
pub fn redact(lines: &Lines) -> Result<Lines, Error> {
    redact_anchored(lines, &[]).map(|(lines, _)| lines)
}

/// Redact with exact UTF-16 insertion anchors in the joined source (newlines
/// separate outer lines). A position inside any redaction match is withheld,
/// never snapped to the replacement. Invalid or split-surrogate offsets fail.
/// This intentionally withholds even retained capture prefixes within a match:
/// matching replacement text is not evidence of source-position provenance.
pub fn redact_anchored(
    lines: &Lines,
    anchors: &[usize],
) -> Result<(Lines, Vec<Option<usize>>), Error> {
    redact_with_anchors(lines, redactors()?, anchors)
}

#[cfg(test)]
fn redact_with(lines: &Lines, redactors: &[Redactor]) -> Result<Lines, Error> {
    redact_with_anchors(lines, redactors, &[]).map(|(lines, _)| lines)
}

/// The lines are joined with `\n` and redacted as one text. Each piece keeps what was not taken
/// out, and a run taken out leaves one marker, in the piece holding the first character it took
/// (none where it took only the line breaks between lines, which stay). Each piece's start is an
/// edge: a key's prefix there has its word edge.
fn redact_with_anchors(
    lines: &Lines,
    redactors: &[Redactor],
    anchors: &[usize],
) -> Result<(Lines, Vec<Option<usize>>), Error> {
    let mut text = String::new();
    let mut pieces = Vec::new();
    let mut separators = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            separators.push(text.len());
            text.push('\n');
        }
        for item in line {
            let start = text.len();
            text.push_str(item);
            pieces.push(start..text.len());
        }
    }
    // Validate native insertion offsets against actual scalar boundaries. Never
    // round an offset inside a surrogate pair to a nearby character.
    let mut places = vec![0; anchors.len()];
    let mut requested: Vec<(usize, usize)> = anchors
        .iter()
        .copied()
        .enumerate()
        .map(|(index, anchor)| (anchor, index))
        .collect();
    requested.sort_unstable();
    let mut requested = requested.into_iter().peekable();
    let mut offset = 0;
    let boundaries = text
        .char_indices()
        .map(|(at, ch)| (at, ch.len_utf16()))
        .chain(std::iter::once((text.len(), 0)));
    for (at, width) in boundaries {
        while let Some(&(anchor, index)) = requested.peek() {
            if anchor > offset {
                break;
            }
            if anchor < offset {
                return Err(Error::InvalidBoundary);
            }
            places[index] = at;
            requested.next();
        }
        offset += width;
    }
    if requested.peek().is_some() {
        return Err(Error::InvalidBoundary);
    }
    // A line's items are pieces of one text (a terminal's connected runs), not pieces the screen
    // shows on their own: no item starts a word.
    let found = scan::scan(&text, &[], redactors);
    let runs = runs(&found);
    let mut output = Vec::with_capacity(pieces.len());
    let mut next = 0;
    let mut marked = vec![false; runs.len()];
    // Where each run's marker goes: the first character it took that a piece holds.
    let mut marks = Vec::new();
    for piece in &pieces {
        let mut result = String::new();
        let mut at = piece.start;
        while at < piece.end {
            while next < runs.len() && runs[next].end <= at {
                next += 1;
            }
            match runs.get(next) {
                Some(run) if run.start <= at => {
                    if !marked[next] {
                        marked[next] = true;
                        marks.push(at);
                        result.push_str(PLACEHOLDER);
                    }
                    at = run.end.min(piece.end);
                }
                run => {
                    let until = run.map_or(piece.end, |run| run.start.min(piece.end));
                    result.push_str(&text[at..until]);
                    at = until;
                }
            }
        }
        output.push(result);
    }
    let mut output = output.into_iter();
    let lines = lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|_| output.next().unwrap_or_default())
                .collect()
        })
        .collect();
    // An anchor inside a match, or inside a run, is withheld; any other moves to where its
    // character is in the joined result.
    let anchors = places
        .iter()
        .map(|&place| {
            let inside = |range: &Range<usize>| range.start < place && place < range.end;
            if found.iter().any(|f| inside(&f.matched)) || runs.iter().any(inside) {
                return None;
            }
            let mut moved = 0;
            let mut at = 0;
            for run in runs.iter().filter(|run| run.end <= place) {
                moved += text[at..run.start].encode_utf16().count();
                moved += separators.iter().filter(|&&s| run.contains(&s)).count();
                at = run.end;
            }
            moved += text[at..place].encode_utf16().count();
            moved += PLACEHOLDER.len() * marks.iter().filter(|&&mark| mark < place).count();
            Some(moved)
        })
        .collect();
    Ok((lines, anchors))
}

#[cfg(test)]
mod tests;
