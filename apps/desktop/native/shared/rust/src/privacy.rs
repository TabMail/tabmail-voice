// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use fancy_regex::{Captures, Regex, RegexBuilder};
use serde_json::Value;
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

#[derive(Clone, Copy)]
struct Range {
    start: usize,
    end: usize,
}
struct Edit {
    old: Range,
    new: Range,
    kept_start: usize,
    kept_end: usize,
}

fn moved(place: usize, edits: &[Edit]) -> usize {
    let (mut old_end, mut new_end) = (0, 0);
    for edit in edits {
        if place <= edit.old.start {
            break;
        }
        if place < edit.old.end {
            if place - edit.old.start <= edit.kept_start {
                return edit.new.start + place - edit.old.start;
            }
            return edit.new.end - edit.kept_end;
        }
        old_end = edit.old.end;
        new_end = edit.new.end;
    }
    new_end + (place - old_end)
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
    static RULES: OnceLock<Result<Vec<Rule>, Error>> = OnceLock::new();
    let rules = RULES
        .get_or_init(|| compile(DEFINITIONS))
        .as_ref()
        .map_err(|e| *e)?;
    redact_with_anchors(lines, rules, anchors)
}

/// Redact one text, and say where each byte of the result came from: the byte of `text` it is, or
/// `None` for a byte a replacement put in. The rules run as `redact` runs them; a replacement keeps
/// what its template copies around the placeholder (a captured label such as `token=`, the `@`
/// after an address password) where the match has it at its ends, and every other character it
/// covered is gone, even one that looks like the marker. The bytes kept stay in order.
pub fn redact_traced(text: &str) -> Result<(String, Vec<Option<usize>>), Error> {
    static RULES: OnceLock<Result<Vec<Rule>, Error>> = OnceLock::new();
    let rules = RULES
        .get_or_init(|| compile(DEFINITIONS))
        .as_ref()
        .map_err(|e| *e)?;
    Ok(trace_with(text, rules))
}

fn trace_with(text: &str, rules: &[Rule]) -> (String, Vec<Option<usize>>) {
    let mut text = text.to_owned();
    let mut origin: Vec<Option<usize>> = (0..text.len()).map(Some).collect();
    for rule in rules {
        let mut result = String::new();
        let mut result_origin = Vec::new();
        let mut copied = 0;
        let mut finished = true;
        for item in rule.regex.captures_iter(text.as_str()) {
            let Ok(captures) = item else {
                finished = false;
                break;
            };
            let Some(matched) = captures.get(0) else {
                finished = false;
                break;
            };
            result.push_str(&text[copied..matched.start()]);
            result_origin.extend_from_slice(&origin[copied..matched.start()]);
            let old = matched.as_str();
            let replacement = expand(&rule.replacement, &captures);
            // What the template copies around the placeholder (a captured label such as `token=`,
            // the `@` after an address password) is kept where the match has it at its ends; the
            // rest of the match is gone, whatever it looks like.
            let (head, tail) = rule
                .replacement
                .split_once(PLACEHOLDER)
                .map(|(head, tail)| (expand(head, &captures), expand(tail, &captures)))
                .unwrap_or_default();
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
            let start = matched.start();
            result.push_str(&replacement);
            result_origin.extend_from_slice(&origin[start..start + kept_start]);
            result_origin.extend(std::iter::repeat_n(
                None,
                replacement.len() - kept_start - kept_end,
            ));
            result_origin.extend_from_slice(&origin[matched.end() - kept_end..matched.end()]);
            copied = matched.end();
        }
        if finished {
            result.push_str(&text[copied..]);
            result_origin.extend_from_slice(&origin[copied..]);
        } else {
            // Never log the engine error: only the trusted canonical rule name.
            eprintln!("debug redactor unfinished: {}", rule.name);
            result.push_str(PLACEHOLDER);
            result_origin.extend(std::iter::repeat_n(None, PLACEHOLDER.len()));
        }
        text = result;
        origin = result_origin;
    }
    (text, origin)
}

#[cfg(test)]
fn redact_with(lines: &Lines, rules: &[Rule]) -> Result<Lines, Error> {
    redact_with_anchors(lines, rules, &[]).map(|(lines, _)| lines)
}

fn redact_with_anchors(
    lines: &Lines,
    rules: &[Rule],
    anchors: &[usize],
) -> Result<(Lines, Vec<Option<usize>>), Error> {
    let mut text = String::new();
    let mut ranges = Vec::new();
    let mut position = 0;
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            text.push('\n');
            position += 1;
        }
        let mut places = Vec::new();
        for item in line {
            let start = position;
            text.push_str(item);
            position += item.encode_utf16().count();
            places.push(Range {
                start,
                end: position,
            });
        }
        ranges.push(places);
    }
    // Validate native insertion offsets against actual scalar boundaries. Never
    // round an offset inside a surrogate pair to a nearby character.
    let mut requested = anchors.to_vec();
    requested.sort_unstable();
    requested.dedup();
    let mut requested = requested.into_iter().peekable();
    let mut offset = 0;
    for width in std::iter::once(0).chain(text.chars().map(char::len_utf16)) {
        offset += width;
        match requested.peek() {
            Some(&next) if next == offset => {
                requested.next();
            }
            Some(&next) if next < offset => return Err(Error::InvalidBoundary),
            None => break,
            _ => {}
        }
    }
    if requested.peek().is_some() {
        return Err(Error::InvalidBoundary);
    }
    let mut anchors: Vec<Option<usize>> = anchors.iter().copied().map(Some).collect();
    for rule in rules {
        let mut result = String::new();
        let mut edits = Vec::new();
        let (mut copied, mut copied16, mut result16) = (0, 0, 0);
        let mut finished = true;
        for item in rule.regex.captures_iter(text.as_str()) {
            let captures = match item {
                Ok(captures) => captures,
                Err(_) => {
                    finished = false;
                    break;
                }
            };
            let matched = captures.get(0).ok_or(Error::InvalidBoundary)?;
            let between = &text[copied..matched.start()];
            let between16 = between.encode_utf16().count();
            result.push_str(between);
            result16 += between16;
            let start = copied16 + between16;
            let old: Vec<u16> = matched.as_str().encode_utf16().collect();
            let replacement = expand(&rule.replacement, &captures);
            let new: Vec<u16> = replacement.encode_utf16().collect();
            let shorter = old.len().min(new.len());
            let mut kept_start = 0;
            while kept_start < shorter && old[kept_start] == new[kept_start] {
                kept_start += 1;
            }
            let mut kept_end = 0;
            while kept_end < shorter - kept_start
                && old[old.len() - 1 - kept_end] == new[new.len() - 1 - kept_end]
            {
                kept_end += 1;
            }
            let end = start + old.len();
            let new_start = result16;
            result.push_str(&replacement);
            result16 += new.len();
            edits.push(Edit {
                old: Range { start, end },
                new: Range {
                    start: new_start,
                    end: result16,
                },
                kept_start,
                kept_end,
            });
            copied = matched.end();
            copied16 = end;
        }
        if finished {
            result.push_str(&text[copied..]);
        } else {
            // Never log the engine error: only the trusted canonical rule name.
            eprintln!("debug redactor unfinished: {}", rule.name);
            let new_start = result16;
            result.push_str(PLACEHOLDER);
            result16 += PLACEHOLDER.len();
            edits.push(Edit {
                old: Range {
                    start: copied16,
                    end: text.encode_utf16().count(),
                },
                new: Range {
                    start: new_start,
                    end: result16,
                },
                kept_start: 0,
                kept_end: 0,
            });
        }
        for anchor in &mut anchors {
            if let Some(place) = *anchor {
                *anchor = if edits
                    .iter()
                    .any(|edit| edit.old.start < place && place < edit.old.end)
                {
                    None
                } else {
                    Some(moved(place, &edits))
                };
            }
        }
        for line in &mut ranges {
            for range in line {
                *range = Range {
                    start: moved(range.start, &edits),
                    end: moved(range.end, &edits),
                };
            }
        }
        text = result;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let lines = ranges
        .iter()
        .map(|line| {
            line.iter()
                .map(|r| {
                    let part = units.get(r.start..r.end).ok_or(Error::InvalidBoundary)?;
                    String::from_utf16(part).map_err(|_| Error::InvalidBoundary)
                })
                .collect()
        })
        .collect::<Result<Lines, Error>>()?;
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
