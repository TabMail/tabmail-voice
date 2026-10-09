// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use std::ops::Range;

/// The retained range is private recognition source, not publishable text.
/// Native callers must establish the source-edge facts before calling this.
pub(crate) fn recognition_range(
    text: &str,
    start_known: bool,
    end_known: bool,
) -> Result<Range<usize>, u32> {
    recognition_range_with_limit(text, start_known, end_known, crate::semantic::MAX_BYTES)
}

pub(crate) fn recognition_range_with_limit(
    text: &str,
    start_known: bool,
    end_known: bool,
    limit: usize,
) -> Result<Range<usize>, u32> {
    if text.len() > limit {
        return Err(1);
    }
    if start_known && end_known {
        return Ok(0..text.len());
    }
    // These actual source delimiters reset every redactor's recognition
    // state but one: a private key's end line takes the text before it back
    // to the read's start, past them (the owner's rule), so a window that
    // stops before such a line keeps text the whole read would take.
    // Whitespace alone does not: named-value and PEM continuations can span
    // an arbitrarily long whitespace run.
    // Keep the delimiter itself so concatenating approved source windows
    // cannot erase the evidence that closed the preceding recognition state.
    let mut characters = text.char_indices().peekable();
    let mut first = None;
    let mut last = None;
    while let Some((start, ch)) = characters.next() {
        if !matches!(ch, '.' | ',' | ';' | '!' | '?')
            || !characters
                .peek()
                .is_some_and(|&(_, next)| next.is_whitespace())
        {
            continue;
        }
        let mut end = start + ch.len_utf8();
        while let Some(&(offset, next)) = characters.peek() {
            if !next.is_whitespace() {
                break;
            }
            end = offset + next.len_utf8();
            characters.next();
        }
        first.get_or_insert(start);
        last = Some(end);
    }
    let start = if start_known {
        0
    } else if let Some(start) = first {
        start
    } else {
        return Ok(0..0);
    };
    let end = if end_known {
        text.len()
    } else if let Some(end) = last {
        end
    } else {
        return Ok(0..0);
    };
    Ok(start..end)
}

/// Preserve source-to-visible mapping for indexed and opaque native ranges alike.
pub(crate) fn field_parts(
    parts: &[String],
    start_known: bool,
    end_known: bool,
) -> Result<Vec<String>, u32> {
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.len() > crate::context::SOURCE_WINDOW_BYTES)
    {
        return Err(1);
    }
    let text = parts.concat();
    let retained = recognition_range_with_limit(
        &text,
        start_known,
        end_known,
        3 * crate::context::SOURCE_WINDOW_BYTES,
    )?;
    let mut offset = 0;
    Ok(parts
        .iter()
        .map(|part| {
            let end = offset + part.len();
            let from = offset.max(retained.start);
            let to = end.min(retained.end);
            offset = end;
            if from < to {
                text[from..to].to_owned()
            } else {
                String::new()
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn kept(text: &str, start: bool, end: bool) -> String {
        text[recognition_range(text, start, end).unwrap()].to_owned()
    }
    #[test]
    fn a_paragraph_separator_the_provider_gives_ends_a_sentence() {
        // The text's own U+2029 is a line break like any other (ADR-DESK-007, 2026-10-07): a
        // sentence ending before one is a delimiter at both open edges.
        assert_eq!(
            kept("head.\u{2029}middle.\u{2029}tail", false, false),
            ".\u{2029}middle.\u{2029}"
        );
    }
    #[test]
    fn source_edge_facts_are_required_not_assumed() {
        for value in [
            serde_json::json!({"window":{"text":"source"}}),
            serde_json::json!({"window":{"text":"source", "startKnown":true,"endKnown":null}}),
            serde_json::json!({"window":{"text":"source", "startKnown":1,"endKnown":true}}),
        ] {
            assert!(crate::context::process(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
    #[test]
    fn complete_small_sources_keep_every_byte() {
        assert_eq!(
            kept("password=synthetic123", true, true),
            "password=synthetic123"
        );
        assert_eq!(kept("", true, true), "");
    }
    #[test]
    fn open_edges_withhold_ambiguous_tokens_but_keep_closed_middle() {
        assert_eq!(
            kept("unknown123. Visible sentence! unfinished456", false, false),
            ". Visible sentence! "
        );
        assert_eq!(kept("unknown123. Visible", false, true), ". Visible");
        assert_eq!(kept("Visible! unfinished456", true, false), "Visible! ");
    }
    #[test]
    fn whitespace_alone_cannot_end_a_pending_secret_prefix() {
        assert_eq!(kept("\n\n tokenvalue123\nremaining", false, false), "");
        assert_eq!(
            kept("-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB", false, false),
            ""
        );
    }
    #[test]
    fn unicode_boundaries_are_byte_exact_and_zero_width_space_is_not_a_reset() {
        let text = "é😀, \u{2003}Readable界! ";
        let range = recognition_range(text, false, false).unwrap();
        assert!(text.is_char_boundary(range.start) && text.is_char_boundary(range.end));
        assert_eq!(&text[range], ", \u{2003}Readable界! ");
        assert_eq!(kept("unknown.\u{200b}notclosed", false, false), "");
    }
    #[test]
    fn source_bound_refuses_instead_of_clipping_recognition_input() {
        assert!(
            recognition_range(&"x".repeat(crate::semantic::MAX_BYTES + 1), true, true).is_err()
        );
        assert_eq!(
            recognition_range(&"x".repeat(crate::semantic::MAX_BYTES), true, true)
                .unwrap()
                .end,
            crate::semantic::MAX_BYTES
        );
    }
}
