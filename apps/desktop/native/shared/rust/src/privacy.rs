// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use fancy_regex::{Captures, Regex, RegexBuilder};
use serde_json::Value;
use std::ops::Range;
use std::sync::OnceLock;

pub type Lines = Vec<Vec<String>>;
pub const PLACEHOLDER: &str = "[redacted]";
const DEFINITIONS: &str = include_str!("../../privacy/redactors.json");

struct Rule {
    name: String,
    regex: Regex,
    replacement: String,
}

/// Errors contain no captured text or engine diagnostic payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidDefinitions,
    InvalidBoundary,
}

fn compile(source: &str) -> Result<Vec<Rule>, Error> {
    let invalid = || Error::InvalidDefinitions;
    let json: Value = serde_json::from_str(source).map_err(|_| invalid())?;
    if json["placeholder"].as_str() != Some(PLACEHOLDER) {
        return Err(invalid());
    }
    let mut rules = Vec::new();
    for definition in json["redactors"].as_array().ok_or_else(invalid)? {
        let name = definition["name"].as_str().ok_or_else(invalid)?;
        if !name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || definition["description"].as_str().is_none_or(str::is_empty)
            || !definition["replacement"]
                .as_str()
                .is_some_and(|s| s.contains("{placeholder}"))
        {
            return Err(invalid());
        }
        let pattern = definition["pattern"].as_str().ok_or_else(invalid)?;
        let ignore_case = definition["ignoreCase"].as_bool().ok_or_else(invalid)?;
        let replacement = definition["replacement"]
            .as_str()
            .ok_or_else(invalid)?
            .replace("{placeholder}", PLACEHOLDER);
        let regex = RegexBuilder::new(pattern)
            .case_insensitive(ignore_case)
            // A fixed operation count rejects benign long pages. Patterns are trusted,
            // immutable definitions; the hostile corpus gates their running time.
            .backtrack_limit(usize::MAX)
            .seek(false)
            .build()
            .map_err(|_| invalid())?;
        if rules.iter().any(|r: &Rule| r.name == name) {
            return Err(invalid());
        }
        validate_replacement(&replacement, regex.captures_len())?;
        rules.push(Rule {
            name: name.into(),
            regex,
            replacement,
        });
    }
    if rules.is_empty() {
        return Err(invalid());
    }
    Ok(rules)
}

fn validate_replacement(template: &str, groups: usize) -> Result<(), Error> {
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            chars.next();
        } else if ch == '$' && chars.peek().is_some_and(char::is_ascii_digit) {
            let mut group = 0usize;
            while let Some(digit) = chars.peek().and_then(|c| c.to_digit(10)) {
                group = group
                    .checked_mul(10)
                    .and_then(|n| n.checked_add(digit as usize))
                    .ok_or(Error::InvalidDefinitions)?;
                chars.next();
            }
            if group == 0 || group >= groups {
                return Err(Error::InvalidDefinitions);
            }
        }
    }
    Ok(())
}

fn expand(template: &str, captures: &Captures<'_, str>) -> String {
    let mut result = String::new();
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some() {
            result.push(chars.next().unwrap());
        } else if ch == '$' && chars.peek().is_some_and(char::is_ascii_digit) {
            let mut group = 0usize;
            while let Some(digit) = chars.peek().and_then(|c| c.to_digit(10)) {
                group = group * 10 + digit as usize;
                chars.next();
            }
            if let Some(value) = captures.get(group) {
                result.push_str(value.as_str());
            }
        } else {
            result.push(ch);
        }
    }
    result
}

fn rules() -> Result<&'static [Rule], Error> {
    static RULES: OnceLock<Result<Vec<Rule>, Error>> = OnceLock::new();
    RULES
        .get_or_init(|| compile(DEFINITIONS))
        .as_deref()
        .map_err(|e| *e)
}

/// One match: all of it, and what it takes out, the match without what its rule's template copies
/// around the placeholder at the match's ends (a captured label such as `token=`, the `@` after an
/// address password).
struct Found {
    matched: Range<usize>,
    taken: Range<usize>,
}

/// Every rule's matches in `text`. Each rule looks at the text as it is, never at what another rule
/// left of it, so no rule's redaction can hide a secret from another rule and their order does not
/// matter (owner, 2026-10-08). A rule the engine could not finish takes everything after its last
/// match.
fn find(text: &str, rules: &[Rule]) -> Vec<Found> {
    let mut found = Vec::new();
    for rule in rules {
        let mut searched = 0;
        let mut finished = true;
        // Each search resumes where the last match's taken part ends, not where the match ends:
        // a kept end (the line break after a key's last line) may be where the next secret of
        // the same kind starts. Every step moves at least one character on.
        let mut from = 0;
        while from <= text.len() {
            let captures = match rule.regex.captures_from_pos(text, from) {
                Ok(Some(captures)) => captures,
                Ok(None) => break,
                Err(_) => {
                    finished = false;
                    break;
                }
            };
            let Some(matched) = captures.get(0) else {
                finished = false;
                break;
            };
            let (head, tail) = rule
                .replacement
                .split_once(PLACEHOLDER)
                .map(|(head, tail)| (expand(head, &captures), expand(tail, &captures)))
                .unwrap_or_default();
            let old = matched.as_str();
            let kept_start = if old.starts_with(&head) {
                head.len()
            } else {
                0
            };
            let kept_end = if old[kept_start..].ends_with(&tail) {
                tail.len()
            } else {
                0
            };
            found.push(Found {
                matched: matched.range(),
                taken: matched.start() + kept_start..matched.end() - kept_end,
            });
            searched = matched.end();
            let resume = matched.end() - kept_end;
            from = if resume > matched.start() {
                resume
            } else {
                text[matched.start()..]
                    .chars()
                    .next()
                    .map_or(text.len() + 1, |c| matched.start() + c.len_utf8())
            };
        }
        if !finished {
            // Never log the engine error: only the trusted canonical rule name.
            eprintln!("debug redactor unfinished: {}", rule.name);
            found.push(Found {
                matched: searched..text.len(),
                taken: searched..text.len(),
            });
        }
    }
    found
}

/// What the matches take out of the text, in order: each run is matches that overlap or meet, and
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
    Ok(runs(&find(text, rules()?)))
}

/// Redact the combined text before redistributing it across line/caret boundaries.
/// Only immutable compiled patterns are cached; text and captures belong to this call.
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
    redact_with_anchors(lines, rules()?, anchors)
}

#[cfg(test)]
fn redact_with(lines: &Lines, rules: &[Rule]) -> Result<Lines, Error> {
    redact_with_anchors(lines, rules, &[]).map(|(lines, _)| lines)
}

/// The lines are joined with `\n` and redacted as one text. Each piece keeps what was not taken
/// out, and a run taken out leaves one marker, in the piece holding the first character it took
/// (none where it took only the line breaks between lines, which stay).
fn redact_with_anchors(
    lines: &Lines,
    rules: &[Rule],
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
    let found = find(&text, rules);
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

#[cfg(test)]
mod source_window_boundary_tests {
    use super::*;

    #[test]
    fn every_canonical_rule_stops_before_a_source_window_restart_boundary() {
        let rules = compile(DEFINITIONS).unwrap();
        let corpus: Value =
            serde_json::from_str(include_str!("../../privacy/redaction-cases.json")).unwrap();
        let samples: Vec<String> = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| {
                case["text"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|part| part.as_str().unwrap())
                    .collect()
            })
            .collect();
        for rule in &rules {
            let sample = samples
                .iter()
                .find(|s| s.len() <= 512 && rule.regex.is_match(s).unwrap())
                .unwrap_or_else(|| panic!("missing boundary witness for {}", rule.name));
            for cut in sample
                .char_indices()
                .map(|(offset, _)| offset)
                .chain(std::iter::once(sample.len()))
            {
                for punctuation in ['.', ',', ';', '!', '?'] {
                    for whitespace in [" ", "\n", "\u{2003}"] {
                        let marker = format!("{punctuation}{whitespace}");
                        let modified = format!("{}{marker}{}", &sample[..cut], &sample[cut..]);
                        for matched in rule.regex.find_iter(&modified) {
                            let matched = matched.unwrap();
                            assert!(
                                !(matched.start() < cut && matched.end() > cut + marker.len()),
                                "{} crosses restart boundary at {}",
                                rule.name,
                                cut
                            );
                        }
                    }
                }
            }
        }
    }
}
