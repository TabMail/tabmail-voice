// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one scanner. Each redactor reads the text as read and reports what it found; none sees
//! what another found or took, and every place a prefix, label or header occurs is looked at on
//! its own, so no find can hide another (owner, 2026-10-08). Every scan goes forward through the
//! text, reading each character a bounded number of times; the places found are sorted once.

use super::definitions::{
    AddressPassword, Entropy, JsonWebToken, KeyLines, Kind, Length, NamedValue, PrivateKey,
    Redactor, Set, Token,
};
use icu_casemap::CaseMapper;
use std::ops::Range;

/// One find: all of it, and what it takes out (the find without a name or prefix that stays).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Found {
    pub matched: Range<usize>,
    pub taken: Range<usize>,
}

/// Every redactor's finds in `text`. `edges` are byte offsets, ascending, where a piece of text
/// the screen shows on its own (a link, a bold run, a line's part) starts: a prefix there has its
/// word edge. An edge only ever lets a find start; it never ends one.
pub(super) fn scan(text: &str, edges: &[usize], redactors: &[Redactor]) -> Vec<Found> {
    let mut found = Vec::new();
    // Finds whose prefix follows a word character: kept only where they start inside or right at
    // the end of text another find takes (a key glued to a key).
    let mut glued = Vec::new();
    let folded = Folded::new(text);
    for redactor in redactors {
        match &redactor.kind {
            Kind::Token(token) => tokens(text, edges, &folded, token, &mut found, &mut glued),
            Kind::PrivateKey(key) => private_keys(text, key, &mut found),
            Kind::KeyLines(lines) => key_lines(text, lines, &mut found),
            Kind::JsonWebToken(jwt) => json_web_tokens(text, jwt, &mut found),
            Kind::AddressPassword(address) => address_passwords(text, address, &mut found),
            Kind::NamedValue(named) => named_values(text, &folded, named, &mut found),
            Kind::Entropy(entropy) => random_words(text, edges, entropy, &mut found),
        }
    }
    if !glued.is_empty() {
        glued.sort_by_key(|f: &Found| f.matched.start);
        let mut taken: Vec<Range<usize>> = found.iter().map(|f| f.taken.clone()).collect();
        taken.sort_by_key(|range| range.start);
        let mut next = 0;
        let mut reach: Option<usize> = None;
        for candidate in glued {
            let start = candidate.matched.start;
            while next < taken.len() && taken[next].start <= start {
                reach = reach.max(Some(taken[next].end));
                next += 1;
            }
            if reach.is_some_and(|end| start <= end) {
                // A prefix glued to taken text is part of what it is glued to: it goes too.
                reach = reach.max(Some(candidate.taken.end));
                found.push(Found {
                    taken: candidate.matched.clone(),
                    matched: candidate.matched,
                });
            }
        }
    }
    found
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Where a run of `set` characters starting at `from` ends. Runs are maximal, so every start
/// inside the run last measured shares its end: `cache` keeps that run, and scans that go forward
/// through the text measure each character once.
fn run_end(bytes: &[u8], from: usize, set: impl Fn(u8) -> bool, cache: &mut Range<usize>) -> usize {
    if cache.start <= from && from < cache.end {
        return cache.end;
    }
    let mut end = from;
    while end < bytes.len() && set(bytes[end]) {
        end += 1;
    }
    *cache = from..end;
    end
}

/// Every place `needle` starts in `text`, overlapping ones too.
fn occurrences<'a>(text: &'a str, needle: &'a str) -> impl Iterator<Item = usize> + 'a {
    let mut from = 0;
    std::iter::from_fn(move || {
        let at = from + text.get(from..)?.find(needle)?;
        from = at + needle.chars().next().map_or(1, char::len_utf8);
        Some(at)
    })
}

/// The text case-folded (Unicode simple case folding, one character for one), so a name or prefix
/// that matches whatever its case is looked for by plain comparison.
struct Folded {
    /// Where each character starts in the text.
    starts: Vec<usize>,
    chars: Vec<char>,
    len: usize,
}

impl Folded {
    fn new(text: &str) -> Folded {
        let fold = CaseMapper::new();
        let (starts, chars) = text
            .char_indices()
            .map(|(at, ch)| (at, fold.simple_fold(ch)))
            .unzip();
        Folded {
            starts,
            chars,
            len: text.len(),
        }
    }

    /// Every place `pattern` occurs whatever its case, overlapping ones too: where it starts and
    /// ends, and the index of the character it ends at.
    fn matches(&self, pattern: &str) -> Vec<(usize, usize, usize)> {
        let fold = CaseMapper::new();
        let pattern: Vec<char> = pattern.chars().map(|ch| fold.simple_fold(ch)).collect();
        self.chars
            .windows(pattern.len())
            .enumerate()
            .filter(|(_, window)| *window == pattern.as_slice())
            .map(|(index, _)| {
                let end = index + pattern.len();
                (self.starts[index], self.at(end), end)
            })
            .collect()
    }

    /// Where the character at `index` starts in the text (its length past the last one).
    fn at(&self, index: usize) -> usize {
        self.starts.get(index).copied().unwrap_or(self.len)
    }

    /// The run of characters from the one at `index` whose case fold is in `set`: where it ends,
    /// and where it ends after `most` of them at most, with how many it holds.
    fn run(&self, index: usize, set: &Set, most: usize) -> (usize, usize, usize) {
        let count = self.chars[index..]
            .iter()
            .take_while(|&&ch| ch.is_ascii() && set.has(ch as u8))
            .count();
        (
            self.at(index + count),
            self.at(index + count.min(most)),
            count,
        )
    }
}

fn tokens(
    text: &str,
    edges: &[usize],
    folded: &Folded,
    token: &Token,
    found: &mut Vec<Found>,
    glued: &mut Vec<Found>,
) {
    let bytes = text.as_bytes();
    // Where each prefix starts and ends, and, case-blind, the index of the character it ends at.
    let mut starts: Vec<(usize, usize, usize)> = Vec::new();
    for prefix in &token.prefixes {
        if token.ignore_case {
            starts.extend(folded.matches(prefix));
        } else {
            starts.extend(occurrences(text, prefix).map(|at| (at, at + prefix.len(), 0)));
        }
    }
    starts.sort_unstable();
    let mut cache = 0..0;
    let mut edge = 0;
    for (start, prefix_end, index) in starts {
        let mut body = prefix_end;
        let mut body_index = index;
        if token.space {
            let spaces = if token.ignore_case {
                folded.chars[index..]
                    .iter()
                    .take_while(|ch| ch.is_whitespace())
                    .count()
            } else {
                text[prefix_end..]
                    .char_indices()
                    .find(|(_, ch)| !ch.is_whitespace())
                    .map_or(text.len() - prefix_end, |(offset, _)| offset)
            };
            if spaces == 0 {
                continue;
            }
            body_index += spaces;
            body = if token.ignore_case {
                folded.at(body_index)
            } else {
                body + spaces
            };
        }
        // A case-blind token's body is case-blind too: a character goes when its case fold does.
        let (run, exact_end, length) = match token.length {
            _ if token.ignore_case => {
                let most = match token.length {
                    Length::Exact(exact) => exact,
                    Length::Min(_) => usize::MAX,
                };
                folded.run(body_index, &token.body, most)
            }
            Length::Exact(exact) => {
                let run = run_end(bytes, body, |b| token.body.has(b), &mut cache);
                (run, body + exact.min(run - body), run - body)
            }
            Length::Min(_) => {
                let run = run_end(bytes, body, |b| token.body.has(b), &mut cache);
                (run, run, run - body)
            }
        };
        let whole = match token.length {
            Length::Min(min) if length >= min => Some(run),
            Length::Exact(exact) if length >= exact => Some(exact_end),
            _ => None,
        };
        let find = |end: usize| Found {
            matched: start..end,
            taken: if token.keep_prefix {
                body..end
            } else {
                start..end
            },
        };
        if !token.word_edge || start == 0 || !is_word_byte(bytes[start - 1]) {
            found.extend(whole.map(find));
            continue;
        }
        // Glued to the word before it: a piece the screen shows on its own gives it its word edge.
        // The starts go forward through the text, and so does the edge they are checked against.
        while edge < edges.len() && edges[edge] < start {
            edge += 1;
        }
        if edges.get(edge) == Some(&start) {
            found.extend(whole.map(find));
        }
        // A prefix glued to a key is part of that key, however short what follows it is, whatever
        // the pieces are.
        glued.extend(whole.or((run > body).then_some(run)).map(find));
    }
}

/// A `-----BEGIN … PRIVATE KEY-----` or `-----END … PRIVATE KEY-----` line at `at`, `opening`
/// long: where it ends.
fn key_line(text: &str, at: usize, opening: &str, key: &PrivateKey) -> Option<usize> {
    let bytes = text.as_bytes();
    let words = at + opening.len();
    let mut label = words;
    loop {
        if text[label..].starts_with(&key.label) {
            let mut close = label + key.label.len();
            // After the label come capitals and spaces, at most `wordsMax`, then the close.
            for _ in 0..=key.words_max {
                if text[close..].starts_with(&key.close) {
                    return Some(close + key.close.len());
                }
                if close < bytes.len()
                    && (bytes[close].is_ascii_uppercase() || bytes[close] == b' ')
                {
                    close += 1;
                } else {
                    break;
                }
            }
        }
        if label - words >= key.words_max || label >= bytes.len() || !key.words.has(bytes[label]) {
            return None;
        }
        label += 1;
    }
}

fn private_keys(text: &str, key: &PrivateKey, found: &mut Vec<Found>) {
    let mut lines: Vec<(usize, usize, bool)> = Vec::new();
    for at in occurrences(text, &key.begin) {
        if let Some(end) = key_line(text, at, &key.begin, key) {
            lines.push((at, end, true));
        }
    }
    for at in occurrences(text, &key.end) {
        if let Some(end) = key_line(text, at, &key.end, key) {
            lines.push((at, end, false));
        }
    }
    lines.sort_unstable();
    // A header opens a key; the first end line after it closes it, from the first header open. An
    // end line with nothing open takes the text back to the end of the end line before it, or to
    // the start of the text (owner, 2026-10-08).
    let mut open: Vec<usize> = Vec::new();
    let mut closed = 0;
    for (start, end, begins) in lines {
        if begins {
            open.push(start);
            continue;
        }
        let from = open.first().copied().unwrap_or(closed);
        open.clear();
        found.push(Found {
            matched: from..end,
            taken: from..end,
        });
        closed = end;
    }
    // Each header with no end line after it: a key cut off where the text ends. It takes the
    // words of base64 after it (an escaped line break's backslash too), up to the first character
    // that is neither one of them nor whitespace.
    for start in open {
        let header = key_line(text, start, &key.begin, key).unwrap_or(start);
        let mut end = header;
        for (offset, ch) in text[header..].char_indices() {
            if ch.is_whitespace() {
                continue;
            }
            if !(ch.is_ascii() && (key.body.has(ch as u8) || ch == '\\')) {
                break;
            }
            end = header + offset + 1;
        }
        found.push(Found {
            matched: start..end,
            taken: start..end,
        });
    }
}

fn line_break(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The text's lines: each one's byte range, without its line break (`\r\n` leaves a blank line
/// between, which the scan passes over as it does any blank line).
fn lines(text: &str) -> Vec<Range<usize>> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (at, ch) in text.char_indices() {
        if line_break(ch) {
            lines.push(start..at);
            start = at + ch.len_utf8();
        }
    }
    lines.push(start..text.len());
    lines
}

fn key_lines(text: &str, key: &KeyLines, found: &mut Vec<Found>) {
    let bytes = text.as_bytes();
    let blank = |line: &Range<usize>| text[line.clone()].trim().is_empty();
    let trim = |line: &Range<usize>| {
        let mut range = line.clone();
        while range.start < range.end && matches!(bytes[range.start], b' ' | b'\t') {
            range.start += 1;
        }
        while range.end > range.start && matches!(bytes[range.end - 1], b' ' | b'\t') {
            range.end -= 1;
        }
        range
    };
    // A full line ends with `fullLine` or more base64 characters (and padding), anything but
    // base64 before them: where they start.
    let full = |line: &Range<usize>| {
        let line = trim(line);
        let mut run = line.end;
        let mut padding = 0;
        while run > line.start && bytes[run - 1] == key.padding && padding < 2 {
            run -= 1;
            padding += 1;
        }
        let end = run;
        while run > line.start && key.base64.has(bytes[run - 1]) {
            run -= 1;
        }
        (end - run >= key.full_line).then_some(run)
    };
    // One base64 word: the whole line.
    let word = |line: &Range<usize>| {
        let line = trim(line);
        let body = text[line.clone()].trim_end_matches(key.padding as char);
        line.end - line.start > 0
            && line.end - line.start - body.len() <= 2
            && body.bytes().all(|b| key.base64.has(b))
    };
    let shape = |prefix: &str| -> String {
        prefix
            .chars()
            .map(|ch| if ch.is_ascii_digit() { '0' } else { ch })
            .collect()
    };
    // A source window restarts at a sentence's end (punctuation, then whitespace), so a run of
    // lines never goes on past one: no line after the first has one before its base64.
    let restarts = |range: Range<usize>| {
        let mut chars = text[range].chars().peekable();
        while let Some(ch) = chars.next() {
            if matches!(ch, '.' | ',' | ';' | '!' | '?')
                && chars.peek().is_some_and(|next| next.is_whitespace())
            {
                return true;
            }
        }
        false
    };
    // A line's first base64 word, after the same kind of prefix as `prefix` or, with another
    // prefix, a word as long as a full line starting the line: where it starts and ends (running
    // on over padding and base64 alike, a line of two keys glued), and whether it is that long.
    let lead = |line: &Range<usize>, prefix: &str| -> Option<(usize, bool)> {
        let line = trim(line);
        let rest = &text[line.clone()];
        let skip = if rest.len() >= prefix.len()
            && rest.is_char_boundary(prefix.len())
            && shape(&rest[..prefix.len()]) == prefix
        {
            prefix.len()
        } else if rest.bytes().take_while(|&b| key.base64.has(b)).count() >= key.full_line {
            0
        } else {
            return None;
        };
        if restarts(line.start..line.start + skip) {
            return None;
        }
        let mut at = line.start + skip;
        while at < line.end && matches!(bytes[at], b' ' | b'\t') {
            at += 1;
        }
        let mut end = at;
        while end < line.end && key.base64.has(bytes[end]) {
            end += 1;
        }
        let long = end - at >= key.full_line;
        while end < line.end && (key.base64.has(bytes[end]) || bytes[end] == key.padding) {
            end += 1;
        }
        (end > at).then_some((end, long))
    };
    let lines = lines(text);
    let first_text_line = lines.iter().position(|line| !blank(line));
    let second_text_line =
        first_text_line.and_then(|first| (first + 1..lines.len()).find(|&at| !blank(&lines[at])));
    let mut index = 0;
    while index < lines.len() {
        let Some(start) = full(&lines[index]) else {
            index += 1;
            continue;
        };
        // The run of lines from here: full lines, single words between them, blank lines.
        let mut last = index;
        let mut count = 1;
        let mut next = index + 1;
        while next < lines.len() {
            if blank(&lines[next]) || word(&lines[next]) && full(&lines[next]).is_none() {
                next += 1;
                continue;
            }
            if let Some(run) = full(&lines[next])
                && !restarts(lines[next].start..run)
            {
                last = next;
                count += 1;
                next += 1;
                continue;
            }
            break;
        }
        let last_line = trim(&lines[last]);
        let mut to = last_line.end;
        let prefix = shape(&text[last_line.start..full(&lines[last]).unwrap_or(last_line.start)]);
        // The line the run stops at, when a word as long as a full line starts it: a key's line
        // that goes on with other text counts as one, and ends the key.
        let stop = lines
            .get(next)
            .and_then(|line| lead(line, &prefix))
            .filter(|&(_, long)| long);
        // Otherwise the first base64 word of the next line that is not blank, after the same kind
        // of prefix as the last full line had, whatever follows it (owner, 2026-10-08).
        let after = stop.or_else(|| {
            lines[last + 1..]
                .iter()
                .find(|line| !blank(line))
                .and_then(|line| lead(line, &prefix))
        });
        if let Some((end, long)) = after {
            if long {
                count += 1;
            }
            to = end;
        }
        if count < key.min_lines {
            index += 1;
            continue;
        }
        let mut from = start;
        // A text starting part-way through a key: its first line, one base64 word, goes too.
        if let Some(first) = first_text_line
            && second_text_line == Some(index)
            && !restarts(lines[index].start..start)
        {
            let line = trim(&lines[first]);
            if line.start < line.end
                && text[line.clone()]
                    .bytes()
                    .all(|b| key.base64.has(b) || b == key.padding)
            {
                from = line.start;
            }
        }
        found.push(Found {
            matched: from..to,
            taken: from..to,
        });
        index = last + 1;
    }
}

fn json_web_tokens(text: &str, jwt: &JsonWebToken, found: &mut Vec<Found>) {
    let bytes = text.as_bytes();
    let part = |b: u8| jwt.part.has(b);
    let mut cache = 0..0;
    let dotted = format!(".{}", jwt.start);
    for dot in occurrences(text, &dotted) {
        let first = run_end(bytes, dot + 1, part, &mut cache);
        if first - (dot + 1) <= jwt.start.len() || bytes.get(first) != Some(&b'.') {
            continue;
        }
        let second = run_end(bytes, first + 1, part, &mut cache);
        if second == first + 1 {
            continue;
        }
        // The part before the dot goes from its first `eyJ` with something after it.
        let mut before = dot;
        while before > 0 && part(bytes[before - 1]) {
            before -= 1;
        }
        let start = text[before..dot]
            .find(&jwt.start)
            .filter(|&offset| before + offset + jwt.start.len() < dot)
            .map_or(dot, |offset| before + offset);
        found.push(Found {
            matched: start..second,
            taken: start..second,
        });
    }
}

fn address_passwords(text: &str, address: &AddressPassword, found: &mut Vec<Found>) {
    for at in occurrences(text, &address.start) {
        let user = at + address.start.len();
        let Some(colon) = text[user..]
            .char_indices()
            .find(|&(_, ch)| ch.is_whitespace() || matches!(ch, '/' | ':' | '@'))
            .filter(|&(_, ch)| ch == ':')
            .map(|(offset, _)| user + offset)
        else {
            continue;
        };
        let password = colon + 1;
        let run = text[password..]
            .char_indices()
            .find(|&(_, ch)| ch.is_whitespace() || ch == '/')
            .map_or(text.len(), |(offset, _)| password + offset);
        if let Some(sign) = text[password..run].rfind('@').filter(|&offset| offset > 0) {
            found.push(Found {
                matched: at..password + sign + 1,
                taken: password..password + sign,
            });
        }
    }
}

fn named_values(text: &str, folded: &Folded, named: &NamedValue, found: &mut Vec<Found>) {
    let value_char = |ch: char| !ch.is_whitespace() && ch != '"' && ch != '\'';
    let mut labels: Vec<(usize, usize)> = named
        .labels
        .iter()
        .flat_map(|label| folded.matches(label))
        .map(|(at, end, _)| (at, end))
        .collect();
    labels.sort_unstable();
    let mut cache = 0..0;
    for (at, mut next) in labels {
        let mut rest = text[next..].chars();
        let skip_quote = |next: &mut usize, rest: &mut std::str::Chars| {
            if rest
                .clone()
                .next()
                .is_some_and(|ch| ch == '"' || ch == '\'')
            {
                rest.next();
                *next += 1;
            }
        };
        let skip_space = |next: &mut usize, rest: &mut std::str::Chars| {
            while let Some(ch) = rest.clone().next().filter(|ch| ch.is_whitespace()) {
                rest.next();
                *next += ch.len_utf8();
            }
        };
        skip_quote(&mut next, &mut rest);
        skip_space(&mut next, &mut rest);
        if !rest.next().is_some_and(|ch| ch == '=' || ch == ':') {
            continue;
        }
        next += 1;
        skip_space(&mut next, &mut rest);
        skip_quote(&mut next, &mut rest);
        let value = next;
        let end = if cache.start <= value && value < cache.end {
            cache.end
        } else {
            let end = text[value..]
                .char_indices()
                .find(|&(_, ch)| !value_char(ch))
                .map_or(text.len(), |(offset, _)| value + offset);
            cache = value..end;
            end
        };
        let mut chars = text[value..end].chars();
        if chars.clone().take(named.min).count() < named.min
            || !chars
                .by_ref()
                .take(named.digit_within)
                .any(|ch| ch.is_ascii_digit())
        {
            continue;
        }
        found.push(Found {
            matched: at..end,
            taken: value..end,
        });
    }
}

/// The share of `word`'s characters in word-like runs: a capital and three or more small
/// letters, three or more small letters, or three or more capitals not followed by a small one;
/// with `numbers`, a number of three or more digits too (a size, a year, a rate:
/// `3840x2160_60fps`).
fn word_share(word: &[u8], numbers: bool) -> f64 {
    let mut covered = 0;
    let mut at = 0;
    let lower = |from: usize| {
        word[from..]
            .iter()
            .take_while(|b| b.is_ascii_lowercase())
            .count()
    };
    let digits = |from: usize| {
        word[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    while at < word.len() {
        let b = word[at];
        let run = if b.is_ascii_uppercase() && lower(at + 1) >= 3 {
            1 + lower(at + 1)
        } else if b.is_ascii_lowercase() && lower(at) >= 3 {
            lower(at)
        } else if numbers && b.is_ascii_digit() && digits(at) >= 3 {
            digits(at)
        } else if b.is_ascii_uppercase() {
            let capitals = word[at..]
                .iter()
                .take_while(|b| b.is_ascii_uppercase())
                .count();
            let followed = word.get(at + capitals).is_some_and(u8::is_ascii_lowercase);
            match (capitals, followed) {
                (3.., false) => capitals,
                (4.., true) => capitals - 1,
                _ => 0,
            }
        } else {
            0
        };
        covered += run;
        at += run.max(1);
    }
    covered as f64 / word.len().max(1) as f64
}

fn bits(word: &[u8]) -> f64 {
    let mut counts = [0usize; 128];
    for &b in word {
        counts[(b & 0x7f) as usize] += 1;
    }
    let n = word.len() as f64;
    counts
        .iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / n;
            -p * p.log2()
        })
        .sum()
}

fn random_words(text: &str, edges: &[usize], entropy: &Entropy, found: &mut Vec<Found>) {
    let bytes = text.as_bytes();
    let random = |part: Range<usize>, found: &mut Vec<Found>| {
        let word = &bytes[part.clone()];
        // An internationalized domain name's label (`xn--`, then its letters encoded) is a name.
        if word.len() >= 4 && word[..4].eq_ignore_ascii_case(b"xn--") {
            return;
        }
        // What comes before the hex: letters (a name, `commit`), or the `0x` hex numbers start with.
        let letters = if word.starts_with(b"0x") || word.starts_with(b"0X") {
            2
        } else {
            word.iter().take_while(|b| b.is_ascii_alphabetic()).count()
        };
        let hex = word[letters..]
            .iter()
            .filter(|&&b| b != entropy.padding)
            .all(|&b| entropy.hex.has(b));
        if word.len() >= entropy.min_length
            && word.iter().any(u8::is_ascii_alphabetic)
            && word.iter().any(u8::is_ascii_digit)
            && !hex
            && word_share(word, true) <= entropy.max_word_share
            && bits(word) >= entropy.min_bits
        {
            found.push(Found {
                matched: part.clone(),
                taken: part,
            });
        }
    };
    // Cut a word at each separator piece that is itself word-like (a path's `src`, a branch
    // name's `final`), and look at each part between such pieces.
    let look = |at: usize, end: usize, found: &mut Vec<Found>| {
        let mut part = at;
        let mut piece = at;
        while piece <= end {
            let piece_end = (piece..end)
                .find(|&i| entropy.separators.has(bytes[i]))
                .unwrap_or(end);
            let word = &bytes[piece..piece_end];
            // A number reads as a word but cuts nothing (`sha512-…`, an id's leading digits).
            if word.len() >= 3 && word_share(word, false) >= 1.0 {
                if part < piece {
                    random(trim(bytes, part..piece, &entropy.separators), found);
                }
                part = piece_end;
            }
            piece = piece_end + 1;
        }
        if part < end {
            random(trim(bytes, part..end, &entropy.separators), found);
        }
    };
    let mut edge = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !entropy.word.has(bytes[at]) {
            at += 1;
            continue;
        }
        let mut end = at;
        while end < bytes.len() && entropy.word.has(bytes[end]) {
            end += 1;
        }
        while end < bytes.len() && bytes[end] == entropy.padding {
            end += 1;
        }
        look(at, end, found);
        // A piece the screen shows on its own inside the word (a link glued to a label) is looked
        // at as a word too: a find more, never one less.
        while edge < edges.len() && edges[edge] <= at {
            edge += 1;
        }
        let mut from = at;
        while edge < edges.len() && edges[edge] < end {
            look(from, edges[edge], found);
            from = edges[edge];
            edge += 1;
        }
        if from > at {
            look(from, end, found);
        }
        at = end;
    }
}

fn trim(bytes: &[u8], mut range: Range<usize>, separators: &Set) -> Range<usize> {
    while range.start < range.end && separators.has(bytes[range.start]) {
        range.start += 1;
    }
    while range.end > range.start && separators.has(bytes[range.end - 1]) {
        range.end -= 1;
    }
    range
}
