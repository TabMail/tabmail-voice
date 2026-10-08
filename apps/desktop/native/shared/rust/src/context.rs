// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::privacy;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone)]
struct Block {
    kind: String,
    text: String,
    frame: Option<[f64; 4]>,
    /// Where the block's text starts and ends on screen, when the helper gives it: the box of its
    /// first line (or character) and of its last. A piece that wraps has one frame over all its
    /// lines, which says nothing of where it meets the piece before or after it.
    ends: Option<[[f64; 4]; 2]>,
    source: Option<Vec<String>>,
    runs: Option<Vec<(String, bool)>>,
    /// Whether the text the screen shows starts or ends with a space (`admit` keeps one at each
    /// edge that had any, and `SemanticText` gives it as a hidden run): the block's text is read
    /// without them. A block whose runs start or end hidden is spaced there too: text the screen
    /// does not show is never glued to the piece beside it.
    spaced: [bool; 2],
    /// What the screen shows between the block before and this one (`separator`), set once when
    /// the read is laid out.
    before: &'static str,
}
impl Block {
    fn read(value: &Value) -> Result<Self, u32> {
        let kind = value["kind"].as_str().ok_or(1u32)?;
        if !["text", "heading", "link", "row", "field", "caret"].contains(&kind) {
            return Err(1);
        }
        let mut text = value["text"].as_str().ok_or(1u32)?.to_owned();
        let spaced = [text.starts_with(whitespace), text.ends_with(whitespace)];
        let source = value.get("source").map(read_field).transpose()?;
        if source
            .as_ref()
            .is_some_and(|parts| kind != "field" || parts[1] != text)
        {
            return Err(1);
        }
        let runs = value.get("runs").map(read_runs).transpose()?;
        if let Some(runs) = &runs
            && (source.is_some()
                || !matches!(kind, "row" | "heading" | "link")
                || runs
                    .iter()
                    .filter(|(_, visible)| *visible)
                    .map(|(text, _)| text.as_str())
                    .collect::<String>()
                    != text)
        {
            return Err(1);
        }
        if !matches!(kind, "field" | "caret") && runs.is_none() {
            text = text.trim_matches(whitespace).to_owned();
        }
        let spaced = match &runs {
            Some(runs) => [runs.first(), runs.last()]
                .map(|run| run.is_some_and(|(text, shown)| !shown && !text.is_empty())),
            None => spaced,
        };
        // The marker for what a helper left out is the core's own word, never glued to a piece
        // beside it, so that no redactor reads it as part of a value.
        let spaced = if text == HIDDEN_MARKER {
            [true, true]
        } else {
            spaced
        };
        let frame = if value["frame"].is_null() {
            None
        } else {
            Some(read_box(&value["frame"])?)
        };
        let ends = match value.get("ends") {
            None | Some(Value::Null) => None,
            Some(ends) => match ends.as_array().map(Vec::as_slice) {
                Some([first, last]) => Some([read_box(first)?, read_box(last)?]),
                _ => return Err(1),
            },
        };
        Ok(Self {
            kind: kind.into(),
            text,
            frame,
            ends,
            source,
            runs,
            spaced,
            before: "",
        })
    }
    fn source_bytes(&self) -> usize {
        if let Some(runs) = &self.runs {
            runs.iter().map(|(text, _)| text.len()).sum()
        } else {
            self.source
                .as_ref()
                .map_or(self.text.len(), |parts| parts.iter().map(String::len).sum())
        }
    }
    fn json(&self) -> Value {
        json!({"kind":self.kind,"text":self.text,"frame":self.frame})
    }
    fn inline(&self) -> bool {
        self.kind == "text" || self.kind == "link"
    }
}
/// How far apart, as a share of the smaller box's height, two pieces of one line may be and still be
/// one word: Chromium lays a bold or linked run against the text before it with no gap at all
/// (measured 2026-10-07), and the gap between two words is a space's width, about a quarter of
/// the line. A piece whose box ends well past the next one's start wrapped onto more lines; its
/// last line's end is not known, so a space goes between.
const ABUTTING_GAP: f64 = 0.1;
/// A box the helper gives: four finite numbers, x, y, width and height.
fn read_box(value: &Value) -> Result<[f64; 4], u32> {
    let array = value.as_array().ok_or(1u32)?;
    if array.len() != 4 {
        return Err(1);
    }
    let mut frame = [0.; 4];
    for (index, coordinate) in array.iter().enumerate() {
        frame[index] = coordinate.as_f64().filter(|x| x.is_finite()).ok_or(1u32)?;
    }
    Ok(frame)
}
/// What goes between two blocks as the screen shows them: a line break (two at a jump up to the
/// next column), or, between two pieces of one line, a space where the screen shows one and
/// nothing where they abut (a run of bold or a link inside a word).
fn separator(a: &Block, b: &Block) -> &'static str {
    let (Some(a_frame), Some(b_frame)) = (a.frame, b.frame) else {
        return "\n";
    };
    if [a_frame, b_frame]
        .iter()
        .any(|[_, _, w, h]| *w <= 0. || *h <= 0.)
    {
        return "\n";
    }
    let below = b_frame[1] + b_frame[3] <= a_frame[1];
    // Where a's text ends and b's starts: a's last line and b's first, when the helper gives them
    // (a piece that wraps meets the next one on its last line, not across its frame).
    let shown = |ends: Option<[[f64; 4]; 2]>, end: usize, frame: [f64; 4]| {
        ends.map(|ends| ends[end])
            .filter(|[_, _, w, h]| *w > 0. && *h > 0.)
            .unwrap_or(frame)
    };
    let [ax, ay, aw, ah] = shown(a.ends, 1, a_frame);
    let [bx, by, _, bh] = shown(b.ends, 0, b_frame);
    let overlap = (ay + ah).min(by + bh) - ay.max(by);
    if a.inline() && b.inline() && bx >= ax && overlap >= ah.min(bh) * 0.5 {
        return if a.spaced[1] || b.spaced[0] || (bx - (ax + aw)).abs() > ah.min(bh) * ABUTTING_GAP {
            " "
        } else {
            ""
        };
    }
    if below { "\n\n" } else { "\n" }
}
/// Lays the blocks out once: what goes between each block and the one before it.
fn lay_out(blocks: &mut [Block]) {
    for index in 1..blocks.len() {
        blocks[index].before = separator(&blocks[index - 1], &blocks[index]);
    }
}
/// How much a separator parts two blocks: nothing, a space, a line break, two.
fn rank(separator: &str) -> usize {
    ["", " ", "\n", "\n\n"]
        .iter()
        .position(|s| *s == separator)
        .unwrap_or(0)
}
/// The separator that stands for a run of whitespace at a part's edge: a line break if it holds
/// one, a space if it holds any, nothing if it is empty.
fn edge(run: &str) -> &'static str {
    if run.contains(line_break) {
        "\n"
    } else if run.is_empty() {
        ""
    } else {
        " "
    }
}
/// Drops the blocks that show nothing. What goes between the two blocks either side of one dropped
/// is the more of what went before and after it (a line break over a space), so the lines stay as
/// laid out.
fn drop_empty(blocks: &mut Vec<Block>) {
    let mut kept: Vec<Block> = Vec::with_capacity(blocks.len());
    let mut pending: Option<&'static str> = None;
    for mut block in blocks.drain(..) {
        if let Some(dropped) = pending.take()
            && rank(dropped) > rank(block.before)
        {
            block.before = dropped;
        }
        if block.kind != "caret" && block.text.is_empty() {
            pending = Some(block.before);
            continue;
        }
        kept.push(block);
    }
    *blocks = kept;
}
/// The read laid out as the screen shows it: its text, each byte's part and whether the read shows
/// it.
#[derive(Default)]
struct Layout {
    text: String,
    owner: Vec<usize>,
    shown: Vec<bool>,
}
impl Layout {
    fn push(&mut self, text: &str, part: usize, shown: bool) {
        self.text.push_str(text);
        self.owner.extend(std::iter::repeat_n(part, text.len()));
        self.shown.extend(std::iter::repeat_n(shown, text.len()));
    }
}
fn render(blocks: &[Block]) -> String {
    let mut result = String::new();
    for (index, block) in blocks.iter().enumerate() {
        if index > 0 {
            result.push_str(block.before);
        }
        match block.kind.as_str() {
            "heading" => {
                result.push_str("## ");
                result.push_str(&block.text);
            }
            "link" => {
                result.push('[');
                result.push_str(&block.text);
                result.push(']');
            }
            "row" => {
                result.push_str("| ");
                result.push_str(&block.text);
            }
            "field" | "caret" => {
                let prefix = if block.kind == "field" { "> " } else { "» " };
                for (line_index, line) in block.text.split('\n').enumerate() {
                    if line_index > 0 {
                        result.push('\n');
                    }
                    result.push_str(prefix);
                    result.push_str(line);
                }
            }
            _ => result.push_str(&block.text),
        }
    }
    result
}

// Foundation's whitespace-and-newline set additionally includes zero-width space.
// Keep the Mac reference behavior for all platforms.
pub(crate) fn whitespace(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{200b}'
}

const SCREEN_BYTES: usize = crate::semantic::MAX_BYTES;
/// What stands in the screen read for a part withheld for privacy, on every platform.
const HIDDEN_MARKER: &str = "[hidden for privacy]";
pub(crate) const BLOCK_SOURCE_BYTES: usize = 2 * SCREEN_BYTES + 3;
const FIELD_SOURCE_BYTES: usize = 3 * SOURCE_WINDOW_BYTES;
pub(crate) const SEMANTIC_SOURCE_BYTES: usize = SCREEN_BYTES + FIELD_SOURCE_BYTES + 3;
const ALL_BLOCK_SOURCE_BYTES: usize = SCREEN_BYTES + SEMANTIC_SOURCE_BYTES;
/// A hidden run of spaces only: it hides nothing (`SemanticText` gives a space the screen shows at
/// a block's edge as one).
fn edge_space((text, shown): &(String, bool)) -> bool {
    !shown && !text.is_empty() && text.chars().all(whitespace)
}
fn read_runs(value: &Value) -> Result<Vec<(String, bool)>, u32> {
    let input = value
        .as_array()
        .filter(|v| v.len() <= crate::semantic::MAX_RUNS)
        .ok_or(1u32)?;
    let mut bytes = 0;
    input
        .iter()
        .map(|run| {
            let pair = run.as_array().filter(|v| v.len() == 2).ok_or(1u32)?;
            let text = pair[0]
                .as_str()
                .filter(|s| s.len() <= SOURCE_WINDOW_BYTES)
                .ok_or(1u32)?;
            let visible = pair[1].as_bool().ok_or(1u32)?;
            bytes += text.len();
            if bytes > SEMANTIC_SOURCE_BYTES {
                return Err(1);
            }
            Ok((text.to_owned(), visible))
        })
        .collect()
}
fn read_field(value: &Value) -> Result<Vec<String>, u32> {
    let parts = value.as_array().filter(|a| a.len() == 3).ok_or(1u32)?;
    parts
        .iter()
        .map(|part| {
            part.as_str()
                .filter(|s| s.len() <= SOURCE_WINDOW_BYTES)
                .map(str::to_owned)
                .ok_or(1)
        })
        .collect()
}
pub(crate) const SOURCE_WINDOW_BYTES: usize = crate::semantic::MAX_BYTES;
pub(crate) const SELECTION_SOURCE_BYTES: usize = SCREEN_BYTES - 6;
const CARET_SOURCE_BYTES: usize = SELECTION_SOURCE_BYTES + 2 * SOURCE_WINDOW_BYTES;
// How much of the line at a caret an adapter reads to tell an empty line (a break) from words;
// a longer line is sent as `null`.
const CARET_LINE_BYTES: usize = 3;
/// The most elements a rich editor's text may hold for the caret's or the walk's read of it (Linux
/// AT-SPI asks each a handful of D-Bus calls): one holding more is not read, so a large editor in
/// focus can't spend the screen read's time on it. Measured in Chrome on Ubuntu (2026-10-06): 200
/// paragraphs read in about 0.5 s, 300 in 0.6–0.7 s, 499 in 0.9–1.5 s.
const CARET_SOURCE_ELEMENTS: usize = 300;
const CARET_SIDE_GRAPHEMES: usize = 2_000;
/// How far either side of the selection an adapter reports where paragraphs start (in the
/// provider's offsets): twice the graphemes a side shows, so the breaks of all the text shown are
/// put back.
pub(crate) const PARAGRAPH_START_UNITS: usize = 2 * CARET_SIDE_GRAPHEMES;
/// The line break the core puts back where the screen starts a line the provider's text leaves
/// out (a rich editor's block, a paragraph Chromium gives no break): the text is read as it is
/// laid out, and redacted as it is (ADR-DESK-007, 2026-10-07).
const LINE_BREAK: char = '\n';

fn line_break(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}
/// Where the break goes back before each paragraph start (byte offsets into the parts joined,
/// ascending) whose text has none: offsets into each part, ascending. A start at the selection's
/// start goes before the caret, unless `caret_ends_line`: the caret is then at the end of the line
/// above that paragraph (the text gives both places one offset), and the break follows it. One at
/// the selection's end goes after the selection. One in a selection that would not fit its budget
/// is left out.
fn left_out_breaks(
    parts: &[String],
    starts: &[usize],
    caret_ends_line: bool,
) -> Result<[Vec<usize>; 3], u32> {
    let text = parts.concat();
    if starts.windows(2).any(|pair| pair[0] >= pair[1])
        || starts
            .iter()
            .any(|start| *start == 0 || !text.is_char_boundary(*start))
    {
        return Err(1);
    }
    let (before, selected) = (parts[0].len(), parts[1].len());
    let mut breaks: [Vec<usize>; 3] = Default::default();
    for &start in starts {
        if text[..start].chars().next_back().is_some_and(line_break) {
            continue;
        }
        let (part, at) = if start < before || (start == before && !caret_ends_line) {
            (0, start)
        } else if start < before + selected {
            (1, start - before)
        } else {
            (2, start - before - selected)
        };
        breaks[part].push(at);
    }
    breaks[1].truncate((SELECTION_SOURCE_BYTES - selected) / LINE_BREAK.len_utf8());
    Ok(breaks)
}

fn caret_text(parts: &[String]) -> String {
    format!(
        "{}‸{}{}{}",
        parts[0],
        parts[1],
        if parts[1].is_empty() { "" } else { "‸" },
        parts[2]
    )
}
fn read_caret(value: &Value) -> Result<Vec<String>, u32> {
    let parts: Vec<String> = serde_json::from_value(value.clone()).map_err(|_| 1u32)?;
    if parts.len() != 3
        || parts[0].len() > SOURCE_WINDOW_BYTES
        || parts[1].len() > SELECTION_SOURCE_BYTES
        || parts[2].len() > SOURCE_WINDOW_BYTES
    {
        return Err(1);
    }
    Ok(parts)
}
fn prefix_end(text: &str, graphemes: usize, bytes: usize) -> usize {
    let mut end = 0;
    for (index, (start, part)) in text.grapheme_indices(true).enumerate() {
        if index >= graphemes || start + part.len() > bytes {
            break;
        }
        end = start + part.len();
    }
    end
}
fn suffix_start(text: &str, graphemes: usize, bytes: usize) -> usize {
    let mut start = text.len();
    for (index, (offset, _)) in text.grapheme_indices(true).rev().enumerate() {
        if index >= graphemes || text.len() - offset > bytes {
            break;
        }
        start = offset;
    }
    start
}
/// A cut that would split a marker (`[redacted]`, `[hidden for privacy]`) leaves it out whole
/// instead: a prefix ending inside one ends before it, a suffix starting inside one starts after it.
/// A part of a marker would no longer say what was taken out, and a reply could repeat it.
fn outside_markers(text: &str, cut: usize, prefix: bool) -> usize {
    for marker in [privacy::PLACEHOLDER, HIDDEN_MARKER] {
        for start in cut.saturating_sub(marker.len() - 1)..cut {
            if text.as_bytes()[start..].starts_with(marker.as_bytes()) {
                return if prefix { start } else { start + marker.len() };
            }
        }
    }
    cut
}
fn present_caret(parts: &mut [String]) -> Result<bool, u32> {
    let selection_bytes = parts[1].len() + if parts[1].is_empty() { 3 } else { 6 };
    if selection_bytes > SCREEN_BYTES {
        return Err(3);
    }
    let remaining = SCREEN_BYTES - selection_bytes;
    let before_start = suffix_start(&parts[0], CARET_SIDE_GRAPHEMES, remaining / 2);
    let after_end = prefix_end(
        &parts[2],
        CARET_SIDE_GRAPHEMES,
        remaining - (parts[0].len() - before_start),
    );
    // Reuse any allowance the after-side did not need, keeping nearest context.
    let before_start = suffix_start(&parts[0], CARET_SIDE_GRAPHEMES, remaining - after_end);
    let before_start = outside_markers(&parts[0], before_start, false);
    let after_end = outside_markers(&parts[2], after_end, true);
    let changed = before_start != 0 || after_end != parts[2].len();
    parts[0] = parts[0][before_start..].to_owned();
    parts[2].truncate(after_end);
    Ok(changed)
}
fn present_blocks(blocks: &mut Vec<Block>, reserved: usize) -> Result<bool, u32> {
    if reserved > SCREEN_BYTES {
        return Err(3);
    }
    let mut remaining = SCREEN_BYTES - reserved;
    let mut changed = false;
    for block in blocks.iter_mut().filter(|b| b.kind != "caret") {
        let graphemes = if matches!(block.kind.as_str(), "row" | "heading" | "link") {
            crate::semantic::MAX_GRAPHEMES
        } else {
            usize::MAX
        };
        let mut end = outside_markers(
            &block.text,
            prefix_end(&block.text, graphemes, remaining),
            true,
        );
        if end < block.text.len() && block.kind == "row" {
            // Row text treats ` | ` as a column separator. A prefix must not
            // finish inside that separator, or just after it with no next cell.
            for back in 1..=3 {
                if let Some(start) = end.checked_sub(back)
                    && block.text.as_bytes().get(start..start + 3) == Some(b" | ")
                {
                    end = start;
                    break;
                }
            }
        }
        changed |= end < block.text.len();
        block.text.truncate(end);
        remaining -= end;
    }
    drop_empty(blocks);
    Ok(changed)
}

/// What stands for the text around a caret that is withheld, or that the adapter could not read
/// (`caretUnread`). With text selected, the selection is withheld (the placeholder,
/// `selectionUnavailable`), so agent mode's Edit refuses rather than paste a rewrite of text it never
/// saw. With nothing selected the window is empty: a placeholder there made the app take the caret
/// for a hidden selection, so agent mode chose Edit and refused to write at a caret a dictation
/// pastes at (Firefox on the Mac, 2026-10-06).
pub(crate) fn unread_caret(selects_text: bool) -> Result<Vec<u8>, u32> {
    serde_json::to_vec(&json!({
        "parts": unread_parts(selects_text),
        "selectionUnavailable": selects_text,
    }))
    .map_err(|_| 3)
}

/// The three parts of a caret window that is unread or withheld (`unread_caret`); the render's own
/// withheld caret uses them too.
pub(crate) fn unread_parts(selects_text: bool) -> [String; 3] {
    [
        String::new(),
        if selects_text {
            privacy::PLACEHOLDER
        } else {
            ""
        }
        .to_owned(),
        String::new(),
    ]
}

/// Why a screen read stopped taking text, once an admission fills its budget.
fn budget_stop(used: usize) -> Option<&'static str> {
    (used >= SCREEN_BYTES).then_some("text budget")
}

/// A rich editor's elements as a helper read them (`hypertext`'s `elements`, in the order it went
/// into them, the root first): each one's own text, its caret (a Unicode-scalar offset, or null),
/// its part of the selection (or null), whether it starts a line of its own, and its links in order,
/// each `[offset, element]`, the element null for a link the helper did not go into (its text is no
/// embedded object, U+FFFC, or it leads back into the read). Gives the parts the join takes: each
/// element's text in order, with its caret, its selection's ends and its blocks marked where
/// Chromium means them (ADR-DESK-007, 2026-10-06).
fn hypertext_parts(elements: &[Value]) -> Result<Vec<Value>, u32> {
    struct Element<'a> {
        text: &'a str,
        caret: Option<usize>,
        selection: Option<(usize, usize)>,
        block: bool,
        links: Vec<(usize, Option<usize>)>,
    }
    fn offset(value: &Value) -> Result<usize, u32> {
        value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(1)
    }
    fn mark(parts: &mut Vec<Value>, name: &str) {
        parts.push(json!({ "mark": name }));
    }
    fn flush(parts: &mut Vec<Value>, run: &mut String) {
        if !run.is_empty() {
            parts.push(json!({ "text": std::mem::take(run) }));
        }
    }
    // An element and, in order, every element its links go into; `next` is the element the read
    // goes into next, so the elements sent are in the order the text holds them, each once.
    fn emit(
        read: &[Element],
        id: usize,
        next: &mut usize,
        parts: &mut Vec<Value>,
    ) -> Result<(), u32> {
        let element = &read[id];
        let selected = element.selection;
        let within =
            |index: usize| selected.is_some_and(|(start, end)| index >= start && index < end);
        let mut run = String::new();
        let mut link = 0;
        let mut index = 0;
        for character in element.text.chars() {
            while link < element.links.len()
                && element.links[link].0 == index
                && element.links[link].1.is_none()
            {
                link += 1;
            }
            if link < element.links.len() && element.links[link].0 == index {
                let child = element.links[link].1.ok_or(1u32)?;
                link += 1;
                // Only an embedded object stands for an element of its own.
                if character != '\u{FFFC}' || child != *next {
                    return Err(1);
                }
                *next += 1;
                flush(parts, &mut run);
                let inner = read.get(child).ok_or(1u32)?;
                // A selection ending at an element's start, the caret there (a forward selection's
                // focus, as Shift+Down from a line's start leaves it), holds the break before it.
                if selected.is_some_and(|(start, end)| index == end && index > start)
                    && inner.caret == Some(0)
                {
                    mark(parts, "selectionEnd");
                }
                if inner.block {
                    mark(parts, "blockStart");
                }
                // A caret before the element: Chromium gives the caret at the end of the text
                // before a link to the text holding it, at the link's object, and none to the link.
                if element.caret == Some(index) && inner.caret.is_none() {
                    mark(parts, "caret");
                }
                // A selection's start or end at an element with no part of its own, or an empty
                // one, is at the element's end: Chromium gives an end inside an element at the
                // element's object, and a start or end anywhere else in it a part of its own. A
                // start there is before the break after a paragraph, and an end after it.
                let own = within(index) && inner.selection.is_some_and(|(start, end)| start < end);
                emit(read, child, next, parts)?;
                if selected.is_some_and(|(start, _)| index == start) && !own {
                    mark(parts, "selectionStart");
                }
                if inner.block {
                    mark(parts, "blockEnd");
                }
                if selected.is_some_and(|(_, end)| index + 1 == end) && !own {
                    mark(parts, "selectionEnd");
                }
                index += 1;
                continue;
            }
            if element.caret == Some(index) {
                flush(parts, &mut run);
                mark(parts, "caret");
            }
            if within(index) && selected.is_some_and(|(start, _)| index == start) {
                flush(parts, &mut run);
                mark(parts, "selectionStart");
            }
            run.push(character);
            if within(index) && selected.is_some_and(|(_, end)| index + 1 == end) {
                flush(parts, &mut run);
                mark(parts, "selectionEnd");
            }
            index += 1;
        }
        flush(parts, &mut run);
        // Every link is inside its element's text.
        if link != element.links.len() {
            return Err(1);
        }
        if element.caret == Some(index) {
            mark(parts, "caret");
        }
        Ok(())
    }
    let mut read = Vec::with_capacity(elements.len());
    let mut bytes = 0usize;
    for element in elements {
        let text = element["text"].as_str().ok_or(1u32)?;
        bytes += text.len();
        let mut links = Vec::new();
        for link in element["links"].as_array().ok_or(1u32)? {
            let pair = link.as_array().filter(|pair| pair.len() == 2).ok_or(1u32)?;
            let child = match &pair[1] {
                Value::Null => None,
                value => Some(offset(value)?),
            };
            links.push((offset(&pair[0])?, child));
        }
        read.push(Element {
            text,
            caret: match &element["caret"] {
                Value::Null => None,
                value => Some(offset(value)?),
            },
            selection: match &element["selection"] {
                Value::Null => None,
                Value::Array(pair) if pair.len() == 2 => {
                    Some((offset(&pair[0])?, offset(&pair[1])?))
                }
                _ => return Err(1),
            },
            block: element["block"].as_bool().ok_or(1u32)?,
            links,
        });
    }
    // The helper reads no more elements or text than these; more is no read of this core's.
    if read.is_empty() || read.len() > CARET_SOURCE_ELEMENTS || bytes > CARET_SOURCE_BYTES {
        return Err(1);
    }
    let mut parts = Vec::new();
    let mut next = 1;
    emit(&read, 0, &mut next, &mut parts)?;
    // Every element sent is in the text.
    if next != read.len() {
        return Err(1);
    }
    Ok(parts)
}

/// Inputs have already passed the native provider's pre-read privacy checks.
/// With caret supplied, redact the combined screen before adding layout markers.
pub fn process(input: &[u8]) -> Result<Vec<u8>, u32> {
    let request: Value = serde_json::from_slice(input).map_err(|_| 1u32)?;
    if let Some(blocks) = request.get("blockStarts") {
        return serde_json::to_vec(&crate::blocks::process(blocks)?).map_err(|_| 3);
    }
    if let Some(window) = request.get("blockWindow") {
        let text = window["text"].as_str().ok_or(1u32)?;
        let start = window["startKnown"].as_bool().ok_or(1u32)?;
        let end = window["endKnown"].as_bool().ok_or(1u32)?;
        let retained = crate::source_window::recognition_range_with_limit(
            text,
            start,
            end,
            BLOCK_SOURCE_BYTES,
        )?;
        return serde_json::to_vec(&json!({"text":&text[retained]})).map_err(|_| 3);
    }
    if let Some(window) = request.get("fieldWindow") {
        let parts = read_field(&window["parts"])?;
        let start = window["startKnown"].as_bool().ok_or(1u32)?;
        let end = window["endKnown"].as_bool().ok_or(1u32)?;
        return serde_json::to_vec(
            &json!({"parts":crate::source_window::field_parts(&parts, start, end)?}),
        )
        .map_err(|_| 3);
    }
    if request.get("opaqueProbes") == Some(&Value::Bool(true)) {
        let mut amount = match request.get("scope").and_then(Value::as_str) {
            None if request.get("scope").is_none() => SOURCE_WINDOW_BYTES,
            Some("field") => SOURCE_WINDOW_BYTES,
            Some("block") => BLOCK_SOURCE_BYTES,
            _ => return Err(1),
        };
        let mut probes = Vec::new();
        while amount > 0 {
            probes.push(amount);
            amount /= 2;
        }
        return serde_json::to_vec(&json!({"amounts":probes})).map_err(|_| 3);
    }
    // A rich editor's text, from the parts a helper read in order (ADR-DESK-007, 2026-10-06): AT-SPI
    // gives each paragraph or link of a Chromium contenteditable as an embedded object with text of
    // its own, so the helper sends each element's own text, where its caret and its part of the
    // selection are, and where a block element starts and ends. A block starts a line of its own,
    // and text after one starts a new line; the caret is the first reported, the selection runs from
    // the first part's start to the last part's end. Offsets count Unicode scalars, as AT-SPI does.
    // Each block's line starts with a line break, as the screen shows it, and the text is redacted
    // as it is: a secret the screen shows over two lines is read in two (ADR-DESK-007, 2026-10-07).
    if let Some(hypertext) = request.get("hypertext") {
        let parts = hypertext_parts(
            hypertext
                .get("elements")
                .and_then(Value::as_array)
                .ok_or(1u32)?,
        )?;
        let mut text = String::new();
        let mut length = 0usize;
        let mut after_block = false;
        let mut caret = None;
        let mut selection: Option<(usize, usize)> = None;
        let break_line = |text: &mut String, length: &mut usize| {
            if !text.is_empty() && !text.ends_with(line_break) {
                text.push(LINE_BREAK);
                *length += 1;
            }
        };
        for part in &parts {
            if let Some(run) = part.get("text") {
                let run = run.as_str().ok_or(1u32)?;
                if after_block && !run.is_empty() {
                    break_line(&mut text, &mut length);
                    after_block = false;
                }
                text.push_str(run);
                length += run.chars().count();
                if text.len() > CARET_SOURCE_BYTES {
                    return Err(1);
                }
                continue;
            }
            match part.get("mark").and_then(Value::as_str).ok_or(1u32)? {
                "blockStart" => {
                    break_line(&mut text, &mut length);
                    after_block = false;
                }
                "blockEnd" => after_block = true,
                mark @ ("caret" | "selectionStart") => {
                    if after_block {
                        break_line(&mut text, &mut length);
                        after_block = false;
                    }
                    if mark == "caret" {
                        caret.get_or_insert(length);
                    } else if selection.is_none() {
                        selection = Some((length, length));
                    }
                }
                "selectionEnd" => {
                    // An end after a block holds the block's break.
                    if after_block {
                        break_line(&mut text, &mut length);
                        after_block = false;
                    }
                    match selection.as_mut() {
                        Some(range) => range.1 = length,
                        None => return Err(1),
                    }
                }
                _ => return Err(1),
            }
        }
        return serde_json::to_vec(&json!({
            "text": text,
            "length": length,
            "caret": caret,
            "selection": selection.map(|(start, end)| [start, end]),
        }))
        .map_err(|_| 3);
    }
    // The adapter could not read the text around the caret; it says whether text is selected (true
    // when it doesn't know).
    if let Some(unread) = request.get("caretUnread") {
        return unread_caret(unread["selectsText"].as_bool().ok_or(1u32)?);
    }
    if let Some(window) = request.get("caretWindow") {
        let mut parts = read_caret(&window["parts"])?;
        let mut start_known = window["startKnown"].as_bool().ok_or(1u32)?;
        let mut end_known = window["endKnown"].as_bool().ok_or(1u32)?;
        // Chromium's text leaves out the break before a paragraph that starts right after text
        // (each <div> of a rich editor): the adapter says where its paragraphs start, and each such
        // break is put back, so the text reads in the lines it is laid out in, and is redacted so
        // (ADR-DESK-007, 2026-10-07). Absent: nothing told, nothing added. `caretEndsLine`: the
        // caret is at the end of a line, not the start of a paragraph at the same offset (absent:
        // it starts it).
        // A caret source sends the paragraph starts near the caret, or what starts at the caret,
        // never both: the starts already say whether a paragraph starts at the caret.
        if window.get("paragraphStarts").is_some() && window.get("caretStarts").is_some() {
            return Err(1);
        }
        let mut breaks: [Vec<usize>; 3] = Default::default();
        if let Some(starts) = window.get("paragraphStarts") {
            let starts: Vec<usize> = serde_json::from_value(starts.clone()).map_err(|_| 1u32)?;
            let caret_ends_line = match window.get("caretEndsLine") {
                None => false,
                Some(value) => value.as_bool().ok_or(1u32)?,
            };
            breaks = left_out_breaks(&parts, &starts, caret_ends_line)?;
        }
        // A caret that starts a paragraph or an empty line, whose break the text before it doesn't
        // show, gets the break: Chromium gives an empty line no character and leaves out some
        // paragraph breaks, so without it the text reads as if the caret followed the last word
        // (ADR-DESK-007, 2026-10-06). The adapter says what it measured (`caretStarts`, absent:
        // nothing, no break): whether a paragraph starts at the caret, whether a line does, and the
        // first few bytes of that line. A line holding only a break is an empty line (Chromium puts
        // its caret where the paragraph above ends); a soft-wrapped line holds words and gets none.
        // The break is counted in the before-part's budget: one at the limit gives up its first
        // character, and its start.
        let starts_paragraph = match window.get("caretStarts") {
            None => false,
            Some(starts) => {
                let paragraph = starts["paragraph"].as_bool().ok_or(1u32)?;
                let line = starts["line"].as_bool().ok_or(1u32)?;
                // `null`: the line holds more than `CARET_LINE_BYTES`, so words.
                let line_text = match starts.get("lineText").ok_or(1u32)? {
                    Value::Null => None,
                    text => Some(text.as_str().ok_or(1u32)?),
                };
                if line_text.is_some_and(|text| text.len() > CARET_LINE_BYTES) {
                    return Err(1);
                }
                let only_break = line_text.is_some_and(|text| {
                    matches!(text, "" | "\n" | "\r" | "\r\n" | "\u{2028}" | "\u{2029}")
                });
                paragraph || (line && only_break)
            }
        };
        let caret_break = starts_paragraph
            && parts[0]
                .chars()
                .last()
                .is_some_and(|last| !line_break(last));
        // Every break counts in its part's budget: a side that would grow past it gives up
        // characters at its far end first, and that edge is no longer known.
        let grow = breaks[0].len() * LINE_BREAK.len_utf8() + usize::from(caret_break);
        let mut cut = 0;
        while parts[0].len() + grow > SOURCE_WINDOW_BYTES && !parts[0].is_empty() {
            let first = parts[0].chars().next().map_or(0, char::len_utf8);
            parts[0].drain(..first);
            cut += first;
            start_known = false;
        }
        while parts[2].len() + breaks[2].len() * LINE_BREAK.len_utf8() > SOURCE_WINDOW_BYTES
            && parts[2].pop().is_some()
        {
            end_known = false;
        }
        // An open edge is cut where the provider's text closes a token, so the range is found in
        // that text alone: a break put back first could look like the whitespace after a `.` that
        // closes one, and the cut would take a secret's head off. The breaks go back
        // only inside the text kept.
        let text = parts.concat();
        let range = crate::source_window::recognition_range_with_limit(
            &text,
            start_known,
            end_known,
            CARET_SOURCE_BYTES,
        )?;
        let selected_start = parts[0].len();
        let selected_end = selected_start + parts[1].len();
        let caret_withheld = range.start > selected_start || range.end < selected_end;
        let unavailable = !parts[1].is_empty() && caret_withheld;
        // Replacing only the selected fragment would erase recognition context
        // for an adjacent side. Refuse the whole caret window in this case;
        // other independently approved screen blocks remain available.
        if caret_withheld {
            return unread_caret(unavailable);
        }
        let mut offset = 0;
        let mut retained: Vec<String> = parts
            .iter()
            .map(|part| {
                let end = offset + part.len();
                let from = offset.max(range.start);
                let to = end.min(range.end);
                offset = end;
                if from < to {
                    text[from..to].to_owned()
                } else {
                    String::new()
                }
            })
            .collect();
        for &at in breaks[0].iter().rev().filter(|at| **at > cut + range.start) {
            retained[0].insert(at - cut - range.start, LINE_BREAK);
        }
        for &at in breaks[1].iter().rev() {
            retained[1].insert(at, LINE_BREAK);
        }
        let after = retained[2].len();
        for &at in breaks[2].iter().rev().filter(|at| **at <= after) {
            retained[2].insert(at, LINE_BREAK);
        }
        if caret_break {
            retained[0].push('\n');
        }
        return serde_json::to_vec(&json!({"parts":retained,"selectionUnavailable":unavailable}))
            .map_err(|_| 3);
    }
    if let Some(window) = request.get("window") {
        let text = window["text"].as_str().ok_or(1u32)?;
        let start_known = window["startKnown"].as_bool().ok_or(1u32)?;
        let end_known = window["endKnown"].as_bool().ok_or(1u32)?;
        let range = crate::source_window::recognition_range(text, start_known, end_known)?;
        return serde_json::to_vec(&json!({
            "sourceText": &text[range.clone()],
            "sourceStartByte": range.start,
            "sourceEndByte": range.end,
            "prefixWithheld": !start_known,
            "suffixWithheld": !end_known,
            "unavailable": !text.is_empty() && range.is_empty()
        }))
        .map_err(|_| 3);
    }
    if request.get("limits") == Some(&Value::Bool(true)) {
        return serde_json::to_vec(&json!({"screenBytes":SCREEN_BYTES,"blockSourceBytes":BLOCK_SOURCE_BYTES,"semanticGraphemes":crate::semantic::MAX_GRAPHEMES,"caretSideGraphemes":CARET_SIDE_GRAPHEMES,"paragraphStartUnits":PARAGRAPH_START_UNITS,"sourceWindowBytes":SOURCE_WINDOW_BYTES,"selectionSourceBytes":SELECTION_SOURCE_BYTES,"caretSourceBytes":CARET_SOURCE_BYTES,"caretLineBytes":CARET_LINE_BYTES,"caretSourceElements":CARET_SOURCE_ELEMENTS,"sourceChunkUnits":crate::source::CHUNK_UNITS,"fieldRangeCount":64,"hiddenMarker":HIDDEN_MARKER,"redactedMarker":privacy::PLACEHOLDER})).map_err(|_|3);
    }
    if let Some(value) = request.get("reserveCaret") {
        // This copy computes only the prospective presentation reservation.
        // Callers retain the complete source for combined redaction.
        let mut caret = read_caret(value)?;
        present_caret(&mut caret)?;
        let used = caret_text(&caret).len();
        return serde_json::to_vec(&json!({"used":used,"budgetFull":used >= SCREEN_BYTES}))
            .map_err(|_| 3);
    }
    if let Some(value) = request.get("fieldPlan") {
        if !value.is_object() {
            return Err(1);
        }
        let count = match value.get("count") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_u64().ok_or(1u32)?),
        };
        let whole = match value.get("text") {
            None | Some(Value::Null) => false,
            Some(v) => {
                let text = v.as_str().ok_or(1u32)?;
                text.len() <= SOURCE_WINDOW_BYTES
                    && text
                        .graphemes(true)
                        .take(crate::semantic::MAX_GRAPHEMES + 1)
                        .count()
                        <= crate::semantic::MAX_GRAPHEMES
            }
        };
        return serde_json::to_vec(&json!({"probeWhole":count.is_none_or(|n| n <= SOURCE_WINDOW_BYTES as u64),"useWhole":whole})).map_err(|_|3);
    }
    if let Some(value) = request.get("fieldRanges") {
        let count = value["count"].as_u64().ok_or(1u32)?;
        let input = value["ranges"]
            .as_array()
            .filter(|r| r.len() <= 64)
            .ok_or(1u32)?;
        let mut ranges = Vec::with_capacity(input.len());
        for range in input {
            let pair = range.as_array().filter(|r| r.len() == 2).ok_or(1u32)?;
            let start = pair[0].as_u64().ok_or(1u32)?;
            let end = pair[1].as_u64().ok_or(1u32)?;
            if start > end || end > count {
                return Err(1);
            }
            if start != end {
                ranges.push((start, end));
            }
        }
        ranges.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for (start, end) in ranges {
            if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
                last.1 = last.1.max(end);
            } else {
                merged.push((start, end));
            }
        }
        // Only overlapping/touching intervals coalesce. A hidden gap must never
        // become visible merely because two provider ranges surround it.
        return serde_json::to_vec(&json!({"ranges":merged})).map_err(|_| 3);
    }
    if let Some(value) = request.get("admitSemantic") {
        let mut block = Block::read(value)?;
        if block.runs.is_none() {
            return Err(1);
        }
        let used = request["used"]
            .as_u64()
            .filter(|n| *n <= ALL_BLOCK_SOURCE_BYTES as u64)
            .ok_or(1u32)? as usize;
        let duplicate =
            if let Some(previous) = request.get("previous").filter(|p| !p.is_null()) {
                let previous = Block::read(previous)?;
                previous.kind != "caret"
                    && previous.text.nfd().eq(block.text.nfd())
                    && (previous.runs == block.runs
                        || (previous.source.is_none()
                            && previous.runs.as_ref().is_none_or(|runs| {
                                runs.iter().all(|run| run.1 || edge_space(run))
                            })
                            && block.runs.as_ref().is_some_and(|runs| {
                                runs.iter().all(|run| run.1 || edge_space(run))
                            })))
            } else {
                false
            };
        if used >= SCREEN_BYTES || block.text.is_empty() || duplicate {
            block.text.clear();
            block.runs = Some(Vec::new());
        }
        let used = used + block.source_bytes();
        return serde_json::to_vec(&json!({"text":block.text,"runs":block.runs,"used":used,"budgetFull":used >= SCREEN_BYTES,"stop":budget_stop(used)})).map_err(|_|3);
    }
    if let Some(value) = request.get("admitField") {
        let mut parts = read_field(value)?;
        let used = request["used"]
            .as_u64()
            .filter(|n| *n <= ALL_BLOCK_SOURCE_BYTES as u64)
            .ok_or(1u32)? as usize;
        // Do not trim/deduplicate private fragments before matching: whitespace
        // and offscreen prefixes can determine whether visible text is secret.
        if used >= SCREEN_BYTES || parts[1].is_empty() {
            parts = vec![String::new(); 3];
        }
        let used = used + parts.iter().map(String::len).sum::<usize>();
        return serde_json::to_vec(
            &json!({"parts":parts,"used":used,"budgetFull":used >= SCREEN_BYTES,"stop":budget_stop(used)}),
        )
        .map_err(|_| 3);
    }
    if let Some(value) = request.get("admit") {
        let source = value
            .as_str()
            .filter(|s| s.len() <= BLOCK_SOURCE_BYTES)
            .ok_or(1u32)?;
        let used = request["used"]
            .as_u64()
            .filter(|n| *n <= ALL_BLOCK_SOURCE_BYTES as u64)
            .ok_or(1u32)? as usize;
        let previous = request.get("previous");
        if previous.is_some_and(|p| !p.is_null() && !p.is_string()) {
            return Err(1);
        }
        // A space at either edge is kept as one, so the screen read can tell two pieces of one line
        // that abut (a run of bold inside a word) from two words.
        let trimmed = source.trim_matches(whitespace);
        let text = if trimmed.is_empty()
            || used >= SCREEN_BYTES
            || previous
                .and_then(Value::as_str)
                .is_some_and(|p| p.trim_matches(whitespace).nfd().eq(trimmed.nfd()))
        {
            String::new()
        } else {
            let space = |spaced: bool| if spaced { " " } else { "" };
            format!(
                "{}{trimmed}{}",
                space(source.starts_with(whitespace)),
                space(source.ends_with(whitespace))
            )
        };
        let used = used + text.len();
        return serde_json::to_vec(
            &json!({"text":text,"used":used,"budgetFull":used >= SCREEN_BYTES,"stop":budget_stop(used)}),
        )
        .map_err(|_| 3);
    }
    if let Some(value) = request.get("normalize") {
        if request.get("limit").is_some() {
            return Err(1);
        }
        let text = value.as_str().ok_or(1u32)?.trim_matches(whitespace);
        if let Some(previous) = request.get("previous") {
            if !previous.is_null() && !previous.is_string() {
                return Err(1);
            }
            if previous
                .as_str()
                .is_some_and(|previous| previous.nfd().eq(text.nfd()))
            {
                return serde_json::to_vec(&json!({"text":"", "truncated":false}))
                    .map_err(|_| 3u32);
            }
        }
        return serde_json::to_vec(&json!({"text":text, "truncated":false})).map_err(|_| 3u32);
    }
    let mut blocks: Vec<Block> = request["blocks"]
        .as_array()
        .ok_or(1u32)?
        .iter()
        .map(Block::read)
        .collect::<Result<_, _>>()?;
    if blocks.len() > 5_000
        || blocks.iter().filter(|b| b.kind == "caret").count() > 1
        || blocks.iter().any(|b| b.text.len() > BLOCK_SOURCE_BYTES)
    {
        return Err(1);
    }
    let mut response = json!({});
    let mut truncated = false;
    let reserved;
    let empty_caret = json!(["", "", ""]);
    let projected = blocks
        .iter()
        .any(|b| b.source.is_some() || b.runs.is_some());
    if projected && request.get("caret").is_none() && blocks.iter().any(|b| b.kind == "caret") {
        return Err(1);
    }
    if let Some(caret_value) = request.get("caret").or(projected.then_some(&empty_caret)) {
        let caret = read_caret(caret_value)?;
        let block_source_bytes = blocks
            .iter()
            .filter(|b| b.kind != "caret")
            .map(Block::source_bytes)
            .sum::<usize>();
        // Recognition-only side context has its own finite allowance. It must
        // not displace ordinary visible blocks from the presentation budget.
        let source_bytes = block_source_bytes + caret_text(&caret).len();
        if block_source_bytes > ALL_BLOCK_SOURCE_BYTES
            || source_bytes > ALL_BLOCK_SOURCE_BYTES + 2 * SOURCE_WINDOW_BYTES
        {
            return Err(1);
        }
        // A block that shows nothing but blanks is not read: the screen shows nothing there.
        blocks.retain(|b| b.kind == "caret" || !b.text.trim_matches(whitespace).is_empty());
        lay_out(&mut blocks);
        let caret_index = blocks
            .iter()
            .position(|b| b.kind == "caret")
            .unwrap_or(blocks.len());
        // The read is laid out once, as the one text the screen shows (ADR-DESK-007, 2026-10-07):
        // each block's text where it is, with what the screen shows between two blocks (the
        // separator the render puts there), a hidden run, and a field's text around what it shows,
        // where they are. That text is redacted once, last, and the read shows only what survived
        // of the parts it shows: nothing is laid out again after the redaction. `owner` gives each
        // byte's part (a block, or one of the caret's three), `shown` whether the read shows it.
        let caret_parts = blocks.len();
        let mut read = Layout::default();
        for (index, block) in blocks.iter().enumerate() {
            if index > 0 {
                read.push(block.before, index, false);
            }
            if block.kind == "caret" {
                for (part, text) in caret.iter().enumerate() {
                    read.push(text, caret_parts + part, true);
                }
                continue;
            }
            match (&block.runs, &block.source) {
                (Some(runs), _) => {
                    for (text, visible) in runs {
                        read.push(text, index, *visible);
                    }
                }
                (None, Some(parts)) => {
                    for (part, text) in parts.iter().enumerate() {
                        read.push(text, index, part == 1);
                    }
                }
                (None, None) => read.push(&block.text, index, true),
            }
        }
        if caret_index == blocks.len() {
            if !read.text.is_empty() {
                read.push(&LINE_BREAK.to_string(), caret_parts, false);
            }
            for (part, text) in caret.iter().enumerate() {
                read.push(text, caret_parts + part, true);
            }
        }
        let Layout {
            text: source,
            owner,
            shown,
        } = read;
        let taken = privacy::taken(&source).map_err(|_| 3u32)?;
        // Each part gets the characters it shows that the redaction did not take. Where it took
        // text out (one match, or several that overlap or meet), one marker goes in the part that
        // shows the first character taken; where it took out only what the read does not show,
        // none goes, so the read never says where hidden text was.
        let mut parts = vec![Vec::new(); caret_parts + 3];
        let mut copied = 0;
        for run in taken
            .iter()
            .chain(std::iter::once(&(source.len()..source.len())))
        {
            for at in copied..run.start {
                if shown[at] {
                    parts[owner[at]].push(source.as_bytes()[at]);
                }
            }
            let first = run.clone().find(|&at| shown[at]);
            if let Some(at) = first {
                parts[owner[at]].extend_from_slice(privacy::PLACEHOLDER.as_bytes());
            }
            // The caret's window is reported on its own as well: a match that took text it shows
            // marks it too, once.
            if first.is_some_and(|at| owner[at] < caret_parts)
                && let Some(at) = run
                    .clone()
                    .find(|&at| shown[at] && owner[at] >= caret_parts)
            {
                parts[owner[at]].extend_from_slice(privacy::PLACEHOLDER.as_bytes());
            }
            copied = run.end;
        }
        // Runs, parts and markers all start and end on character boundaries.
        let mut parts = parts
            .into_iter()
            .map(String::from_utf8)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| 3u32)?;
        let mut around = parts.split_off(caret_parts);
        let changed = around[1] != caret[1];
        if changed && around[1].trim_matches(whitespace).is_empty() {
            around[1] = privacy::PLACEHOLDER.into();
        }
        truncated |= present_caret(&mut around)?;
        let formatted_caret = caret_text(&around);
        reserved = formatted_caret.len();
        // A part's text is shown without the whitespace at its edges, which the separators stand
        // for. Where the redaction left whitespace at an edge (a match that ended inside a piece
        // that goes on), that whitespace is what the screen shows there, and the separator on that
        // side becomes at least as much.
        let mut owed = "";
        for (block, part) in blocks.iter_mut().zip(parts) {
            if rank(owed) > rank(block.before) {
                block.before = owed;
            }
            owed = "";
            block.text = if block.kind == "caret" {
                formatted_caret.clone()
            } else {
                let lead = edge(&part[..part.len() - part.trim_start_matches(whitespace).len()]);
                if rank(lead) > rank(block.before) {
                    block.before = lead;
                }
                owed = edge(&part[part.trim_end_matches(whitespace).len()..]);
                part.trim_matches(whitespace).to_owned()
            };
            block.source = None;
            block.runs = None;
        }
        drop_empty(&mut blocks);
        response["caret"] = json!(around);
        response["selectionRedacted"] = json!(changed);
    } else {
        if blocks.iter().map(|b| b.text.len()).sum::<usize>() > SCREEN_BYTES + BLOCK_SOURCE_BYTES {
            return Err(1);
        }
        lay_out(&mut blocks);
        reserved = blocks
            .iter()
            .filter(|b| b.kind == "caret")
            .map(|b| b.text.len())
            .sum();
    }
    truncated |= present_blocks(&mut blocks, reserved)?;
    response["truncated"] = json!(truncated);
    response["blocks"] = Value::Array(blocks.iter().map(Block::json).collect());
    response["rendered"] = json!(render(&blocks));
    serde_json::to_vec(&response).map_err(|_| 3u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layout_and_split_selection() {
        let response: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(&json!({
                    "blocks":[
                        {"kind":"text","text":"Author","frame":[0,0,40,20]},
                        {"kind":"link","text":"time","frame":[50,0,30,20]},
                        {"kind":"text","text":"password:"},
                        {"kind":"caret","text":"ignored","frame":[0,40,200,20]},
                        {"kind":"field","text":"line1\nline2","frame":[300,0,200,20]}],
                    "caret":["hunter","2x",""]
                }))
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            response["rendered"],
            "Author [time]\npassword:\n» [redacted]‸[redacted]‸\n\n> line1\n> line2"
        );
        assert_eq!(response["selectionRedacted"], true);
        assert_eq!(response["blocks"][3]["frame"], json!([0., 40., 200., 20.]));
    }
    #[test]
    fn invalid_shape_refuses() {
        for value in [
            json!({}),
            json!({"hypertext":{}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":1,"line":true,"lineText":""}}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":false,"line":true}}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":false,"line":true,"lineText":"abcd"}}}),
            json!({"caretWindow":{"parts":["","",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":false,"line":true,"lineText":7}}}),
            json!({"caretWindow":{"parts":["a","",""],"startKnown":true,"endKnown":true,"paragraphStarts":[1],"caretEndsLine":1}}),
            json!({"hypertext":{"parts":[{"text":"x"}]}}),
            json!({"hypertext":{"elements":[{"text":1,"caret":null,"selection":null,"block":false,"links":[]}]}}),
            json!({"hypertext":{"elements":[{}]}}),
            json!({"blocks":[{"kind":"unknown","text":"x"}]}),
            json!({"blocks":[],"caret":["x"]}),
            json!({"blocks":[{"kind":"text","text":"x","frame":[0,0,1,1],"ends":[[0,0,1,1]]}]}),
            json!({"blocks":[{"kind":"text","text":"x","frame":[0,0,1,1],"ends":[[0,0,1,1],[0,0,1]]}]}),
            json!({"blocks":[{"kind":"text","text":"x","frame":[0,0,1,1],"ends":[[0,0,1,1],[0,"0",1,1]]}]}),
            json!({"blocks":[{"kind":"text","text":"x","frame":[0,0,1,1],"ends":{}}]}),
        ] {
            assert_eq!(process(&serde_json::to_vec(&value).unwrap()), Err(1));
        }
    }
}

#[cfg(test)]
mod normalization_tests {
    use super::*;
    #[test]
    fn mac_whitespace_preserves_complete_source() {
        let call = |value: Value| -> Value {
            serde_json::from_slice(&process(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap()
        };
        assert_eq!(
            call(json!({"normalize":"\u{200b}\u{85} hello\u{a0}"}))["text"],
            "hello"
        );
        assert_eq!(
            call(json!({"normalize":"\u{feff}hello"}))["text"],
            "\u{feff}hello"
        );
        assert_eq!(
            call(json!({"normalize":"a🙂z"})),
            json!({"text":"a🙂z", "truncated":false})
        );
        assert_eq!(
            call(json!({"normalize":" hello ","previous":"hello"}))["text"],
            ""
        );
        assert_eq!(process(br#"{"normalize":5}"#), Err(1));
        assert_eq!(process(br#"{"normalize":"x","limit":-1}"#), Err(1));
    }
}

#[cfg(test)]
mod conformance {
    use super::*;
    #[test]
    fn shared_context_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../context/context-cases.json")).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() >= 11);
        for case in cases {
            let actual: Value = serde_json::from_slice(
                &process(&serde_json::to_vec(&case["request"]).unwrap()).unwrap(),
            )
            .unwrap();
            for (key, expected) in case["expected"].as_object().unwrap() {
                assert_eq!(&actual[key], expected, "{}: {key}", case["name"]);
            }
        }
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    /// However the screen splits a key into pieces of one line (a run of bold, a link), the read
    /// redacts it whole and says where once: the redaction sees the line as the screen shows it.
    #[test]
    fn a_key_split_into_pieces_of_one_line_is_redacted_whole_once() {
        let key = format!("AKIA{}", "A".repeat(16));
        for first in 1..key.len() {
            for second in first + 1..key.len() {
                let pieces = [&key[..first], &key[first..second], &key[second..]];
                let mut x = 0.;
                let blocks: Vec<Value> = pieces
                    .iter()
                    .enumerate()
                    .map(|(index, piece)| {
                        let width = 10. * piece.len() as f64;
                        let block = json!({"kind":if index == 1 {"link"} else {"text"},"text":piece,"frame":[x,0.,width,20.]});
                        x += width;
                        block
                    })
                    .collect();
                let reply: Value = serde_json::from_slice(
                    &process(
                        &serde_json::to_vec(&json!({"blocks":blocks,"caret":["","",""]})).unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap();
                let rendered = reply["rendered"].as_str().unwrap();
                assert_eq!(
                    rendered.matches(privacy::PLACEHOLDER).count(),
                    1,
                    "{first} {second}"
                );
                assert!(
                    !rendered.contains("AKIA") && !rendered.contains("AAAA"),
                    "{first} {second}"
                );
            }
        }
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    const SCREEN: usize = 256 * 1024;
    fn call(value: Value) -> Value {
        serde_json::from_slice(&process(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap()
    }
    #[test]
    fn an_unread_caret_must_say_whether_text_is_selected() {
        for request in [
            json!({"caretUnread":{}}),
            json!({"caretUnread":{"selectsText":"yes"}}),
            json!({"caretUnread":true}),
        ] {
            assert_eq!(
                process(&serde_json::to_vec(&request).unwrap()),
                Err(1),
                "{request}"
            );
        }
    }
    /// A budget never cuts a marker in half: every bracket the read shows belongs to a whole marker,
    /// wherever the cut falls.
    fn whole_markers_only(text: &str) -> bool {
        let rest = text
            .replace(privacy::PLACEHOLDER, "")
            .replace(HIDDEN_MARKER, "");
        !rest.contains('[') && !rest.contains(']')
    }
    #[test]
    fn the_caret_window_budget_never_cuts_a_marker() {
        let (mut kept, mut left_out) = (0, 0);
        for k in 0..=privacy::PLACEHOLDER.len() + 6 {
            let after = format!(
                "{} token=abc123def",
                "x".repeat(CARET_SIDE_GRAPHEMES - 7 - k)
            );
            let before = format!(
                "token=abc123def {}",
                "x".repeat(CARET_SIDE_GRAPHEMES - 17 + k)
            );
            let reply = call(json!({"blocks":[],"caret":[before,"",after]}));
            assert_eq!(reply["truncated"], true);
            for part in [&reply["caret"][0], &reply["caret"][2]] {
                let part = part.as_str().unwrap();
                assert!(whole_markers_only(part), "{k}: {part}");
                // A marker the cut crosses is left out, never kept past the side's budget.
                assert!(part.chars().count() <= CARET_SIDE_GRAPHEMES, "{k}: {part}");
                if part.contains(privacy::PLACEHOLDER) {
                    kept += 1;
                } else {
                    left_out += 1;
                }
            }
        }
        assert!(kept > 0 && left_out > 0);
    }
    #[test]
    fn the_screen_budget_never_cuts_a_marker() {
        let (mut kept, mut left_out) = (0, 0);
        for marker_block in ["token=abc123def", HIDDEN_MARKER] {
            for k in 0..40 {
                let reply = call(json!({"blocks":[
                    {"kind":"text","text":"x".repeat(SCREEN - k)},
                    {"kind":"text","text":marker_block}],"caret":["","",""]}));
                let rendered = reply["rendered"].as_str().unwrap();
                assert!(whole_markers_only(rendered), "{marker_block} {k}");
                if rendered.contains('[') {
                    kept += 1;
                } else {
                    left_out += 1;
                }
            }
        }
        assert!(kept > 0 && left_out > 0);
    }
    #[test]
    fn caret_window_keeps_complete_selection_and_maps_unicode_source_edges() {
        let reply = call(
            json!({"caretWindow":{"parts":["unknown😀. Before ","選択"," after! unfinished"],"startKnown":false,"endKnown":false}}),
        );
        assert_eq!(reply["parts"], json!([". Before ", "選択", " after! "]));
        assert_eq!(reply["selectionUnavailable"], false);
    }
    #[test]
    fn a_left_out_break_is_counted_in_the_before_parts_budget() {
        let before = "Why does it move. ".repeat(SOURCE_WINDOW_BYTES / 18 + 1)
            [..SOURCE_WINDOW_BYTES - 1]
            .to_owned()
            + "x";
        assert_eq!(before.len(), SOURCE_WINDOW_BYTES);
        let reply = call(
            json!({"caretWindow":{"parts":[before,"",""],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":"Wh"}}}),
        );
        let kept = reply["parts"][0].as_str().unwrap();
        assert!(kept.ends_with("x\n") && kept.len() <= SOURCE_WINDOW_BYTES && !kept.is_empty());
        assert_eq!(reply["selectionUnavailable"], false);
    }
    /// The break at the limit costs the before-part its first character, so its start is no longer
    /// known: a key there, its prefix cut off, must not reach the reply as plain text. The rest is
    /// a few large graphemes, so all of it is shown.
    #[test]
    fn a_key_whose_prefix_the_break_cuts_off_is_not_shown() {
        let head = concat!("sk", "-", "A1b2C3d4E5f6G7h8I9j0K1. ");
        let mark = format!("a{}", "\u{301}".repeat(99));
        let mut before =
            head.to_owned() + &mark.repeat((SOURCE_WINDOW_BYTES - head.len()) / mark.len());
        before += &"b".repeat(SOURCE_WINDOW_BYTES - before.len());
        assert_eq!(before.len(), SOURCE_WINDOW_BYTES);
        let window = call(
            json!({"caretWindow":{"parts":[before,""," after"],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":null}}}),
        );
        let reply = call(json!({"blocks":[],"caret":window["parts"]}));
        assert!(reply["caret"][0].as_str().unwrap().ends_with("bbb\n"));
        assert!(!reply.to_string().contains("G7h8I9j0"));
    }
    /// Two keys on lines of their own, the caret at the second's start, whether the break between
    /// them is the text's own or one the caret window put back: each is redacted on its own line,
    /// and neither reaches the reply, whole or in part.
    #[test]
    fn two_keys_at_a_break_are_never_shown_in_part() {
        let (first, second) = (
            concat!("gh", "p_AAAAAAAAAAAAAAAAAAAA"),
            concat!("gh", "p_0123456789abcdefXYZW"),
        );
        let added = call(
            json!({"caretWindow":{"parts":[first,"",second],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":null}}}),
        );
        for caret in [
            json!([format!("{first}\n"), "", second]),
            added["parts"].clone(),
        ] {
            let text =
                call(json!({"blocks":[{"kind":"text","text":"Keys"}],"caret":caret})).to_string();
            assert!(
                !text.contains("AAAAAAAAAAAA") && !text.contains("0123456789abcdef"),
                "{text}"
            );
            assert!(text.contains("Keys"), "{text}");
        }
    }
    /// The break at the limit gives up the before part's first character even when every caret
    /// part is at its largest, so the window still fits the caret source and is read.
    #[test]
    fn a_left_out_break_fits_a_caret_window_at_every_limit() {
        let words = |bytes: usize| {
            "Why does it move. ".repeat(bytes / 18 + 1)[..bytes - 1].to_owned() + "x"
        };
        let parts = [
            words(SOURCE_WINDOW_BYTES),
            words(SELECTION_SOURCE_BYTES),
            words(SOURCE_WINDOW_BYTES),
        ];
        assert_eq!(
            parts.iter().map(String::len).sum::<usize>(),
            CARET_SOURCE_BYTES
        );
        let reply = call(
            json!({"caretWindow":{"parts":parts,"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":true,"lineText":"Wh"}}}),
        );
        assert!(reply["parts"][0].as_str().unwrap().ends_with("x\n"));
        assert_eq!(reply["parts"][1], json!(parts[1]));
    }
    /// Put-back breaks count in a part's budget: a before part at its limit gives up its first
    /// characters and its start, an after part its last and its end. One in a selection at its
    /// limit is not added; one in a selection below it is.
    #[test]
    fn put_back_breaks_keep_every_part_in_its_budget() {
        let words = |bytes: usize| {
            "Why does it move. ".repeat(bytes / 18 + 1)[..bytes - 1].to_owned() + "x"
        };
        let parts = [
            words(SOURCE_WINDOW_BYTES),
            words(SELECTION_SOURCE_BYTES),
            words(SOURCE_WINDOW_BYTES),
        ];
        let (before, selected) = (parts[0].len(), parts[1].len());
        let starts = [18, before, before + 18, before + selected + 18];
        let reply = call(
            json!({"caretWindow":{"parts":parts,"startKnown":true,"endKnown":true,"paragraphStarts":starts}}),
        );
        let reply: Vec<String> = serde_json::from_value(reply["parts"].clone()).unwrap();
        assert!(
            reply
                .iter()
                .map(String::len)
                .zip([
                    SOURCE_WINDOW_BYTES,
                    SELECTION_SOURCE_BYTES,
                    SOURCE_WINDOW_BYTES
                ])
                .all(|(length, limit)| length <= limit)
        );
        assert_eq!(reply[0].matches(LINE_BREAK).count(), 2);
        assert!(reply[0].ends_with("x\n"));
        assert_eq!(reply[1], parts[1]);
        assert_eq!(reply[2].matches(LINE_BREAK).count(), 1);
        // The edges given up are open: each side is cut where the text closes a sentence.
        assert!(reply[0].starts_with(". ") && reply[2].ends_with(". "));
        let short = words(SELECTION_SOURCE_BYTES - LINE_BREAK.len_utf8());
        let reply = call(
            json!({"caretWindow":{"parts":["",short,""],"startKnown":true,"endKnown":true,"paragraphStarts":[18]}}),
        );
        assert_eq!(
            reply["parts"][1],
            json!(format!("{}\n{}", &short[..18], &short[18..]))
        );
        for bad in [&[0][..], &[5, 5], &[9, 4], &[usize::MAX]] {
            assert_eq!(
                left_out_breaks(
                    &[
                        String::from("Why does it move"),
                        String::new(),
                        String::new()
                    ],
                    bad,
                    false
                ),
                Err(1)
            );
        }
        assert_eq!(
            left_out_breaks(
                &[String::from("é"), String::new(), String::new()],
                &[1],
                false
            ),
            Err(1)
        );
    }
    /// A rich editor (Linux's `hypertext`) read through the whole screen, after `label` (a text
    /// block before it): its own text `opening`, then `secret` (its parts, one per block), with the
    /// caret before, after or selecting the secret, or the editor read as a text block of its own
    /// with the caret elsewhere. Gives each reply.
    fn rich_editor_screens(
        label: &str,
        opening: &str,
        secret: &[&str],
    ) -> Vec<(&'static str, Value)> {
        fn call(op: fn(&[u8]) -> Result<Vec<u8>, u32>, value: Value) -> Value {
            serde_json::from_slice(&op(&serde_json::to_vec(&value).unwrap()).unwrap()).unwrap()
        }
        let screen = |blocks: Value, caret: Value, unavailable: Value| {
            call(
                crate::screen::process,
                json!({
                    "appName":"Synthetic editor","exclusions":{"excludedAppIDs":[],"excludedHosts":[]},
                    "nodes":3,"milliseconds":1,"selectionUnavailable":unavailable,
                    "blocks":blocks,"caret":caret
                }),
            )
        };
        let mut replies = Vec::new();
        for mode in ["before", "selected", "after", "block"] {
            // The editor's own text, then an object for each block, each a block element; the
            // caret at the first block's object, or at the editor's end, or each block selected.
            let first = opening.chars().count();
            let caret = match mode {
                "after" => json!(first),
                "before" => json!(first + secret.len()),
                _ => Value::Null,
            };
            let links: Vec<Value> = (0..secret.len())
                .map(|i| json!([first + i, i + 1]))
                .collect();
            let mut elements = vec![
                json!({"text":format!("{opening}{}", "\u{FFFC}".repeat(secret.len())),
                "caret":caret,"selection":null,"block":true,"links":links}),
            ];
            for piece in secret {
                let selection = (mode == "selected").then(|| json!([0, piece.chars().count()]));
                elements.push(json!({"text":piece,"caret":null,"selection":selection,"block":true,"links":[]}));
            }
            let flat = call(process, json!({"hypertext":{"elements":elements}}));
            let text = flat["text"].as_str().unwrap();
            if mode == "block" {
                replies.push((
                    mode,
                    screen(
                        json!([{"kind":"text","text":label},{"kind":"text","text":text},
                            {"kind":"text","text":"Other context."},{"kind":"caret","text":""}]),
                        json!(["", "", ""]),
                        json!(false),
                    ),
                ));
                continue;
            }
            let (start, end) = match mode {
                "selected" => (
                    flat["selection"][0].as_u64().unwrap() as usize,
                    flat["selection"][1].as_u64().unwrap() as usize,
                ),
                _ => {
                    let caret = flat["caret"].as_u64().unwrap() as usize;
                    (caret, caret)
                }
            };
            let mut source =
                crate::source::Source::new_scalar(text.chars().count(), start, end).unwrap();
            while let Some((at, amount)) = source.next().unwrap() {
                let piece: String = text.chars().skip(at).take(amount).collect();
                source.offer_utf8(&piece).unwrap();
            }
            let caret: Value = serde_json::from_slice(&source.finish().unwrap()).unwrap();
            replies.push((
                mode,
                screen(
                    json!([{"kind":"text","text":label},{"kind":"caret","text":""},
                        {"kind":"text","text":"Other context."}]),
                    caret["parts"].clone(),
                    caret["selectionUnavailable"].clone(),
                ),
            ));
        }
        replies
    }
    /// What any field of a reply shows, the content log's included.
    fn shown_anywhere(reply: &Value) -> String {
        [
            "textBeforeCaret",
            "selectedText",
            "textAfterCaret",
            "renderedText",
            "logDescription",
        ]
        .iter()
        .map(|field| reply[field].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\u{0}")
    }
    /// Each block is a line of its own: two tokens in two blocks are each redacted, and neither
    /// body is shown.
    #[test]
    fn a_rich_editors_blocks_never_join_two_tokens() {
        let first = format!("ghp_{}", "Synthetic1".repeat(2));
        let second = format!("ghp_{}", "Fixture234".repeat(2));
        for (mode, reply) in rich_editor_screens("Notes", "Public words.", &[&first, &second]) {
            let shown = shown_anywhere(&reply);
            assert!(
                !shown.contains(&first[4..]) && !shown.contains(&second[4..]),
                "{mode} {shown:?}"
            );
            assert!(shown.contains("Other context."), "{mode}");
        }
    }
    /// A key inside a block's line is redacted, and every block break is shown as a line break.
    #[test]
    fn a_rich_editors_key_inside_a_line_keeps_the_breaks() {
        let key = "sk-ReviewFixture1234567890";
        let line = format!("Key {key}");
        for (mode, reply) in rich_editor_screens("Notes", "Public words.", &["More words.", &line])
        {
            let shown = shown_anywhere(&reply);
            assert!(
                !shown.contains(&key[3..]) && !shown.contains('\u{2029}'),
                "{mode} {shown:?}"
            );
            let rendered = reply["renderedText"].as_str().unwrap();
            match mode {
                "before" => assert!(
                    rendered.contains("Public words.\n» More words.\n» Key [redacted]\n» ‸"),
                    "{rendered:?}"
                ),
                "block" => assert!(
                    rendered.contains("Public words.\nMore words.\nKey [redacted]"),
                    "{rendered:?}"
                ),
                "selected" => assert_eq!(reply["selectionRedacted"], true),
                _ => {}
            }
        }
    }
    /// The whole screen read with `caret` as a helper sent it, after a text block.
    fn screen_with_caret(blocks: Value, caret: Value) -> Value {
        let input = json!({
            "appName":"Synthetic editor","exclusions":{"excludedAppIDs":[],"excludedHosts":[]},
            "nodes":3,"milliseconds":1,"selectionUnavailable":false,"blocks":blocks,"caret":caret
        });
        serde_json::from_slice(
            &crate::screen::process(&serde_json::to_vec(&input).unwrap()).unwrap(),
        )
        .unwrap()
    }
    /// A selection over line breaks the core puts back, with nothing redacted in it, is the user's
    /// text as shown: Edit stays on. Through a rich editor's blocks, and through the breaks a caret
    /// window puts back where Chromium's text leaves them out.
    #[test]
    fn a_clean_selection_over_put_back_breaks_keeps_edit() {
        for (mode, reply) in
            rich_editor_screens("Notes", "Public words.", &["Hi All,", "Why does it move?"])
        {
            if mode == "selected" {
                assert_eq!(reply["selectionRedacted"], false, "{reply:?}");
                assert!(
                    reply["selectedText"]
                        .as_str()
                        .unwrap()
                        .contains("Hi All,\nWhy does it move?"),
                    "{reply:?}"
                );
            }
        }
        let window = call(
            json!({"caretWindow":{"parts":["Intro ","First lineSecond line",""],
            "startKnown":true,"endKnown":true,"paragraphStarts":[16]}}),
        );
        assert_eq!(window["parts"][1], "First line\nSecond line", "{window:?}");
        let reply = screen_with_caret(
            json!([{"kind":"text","text":"Notes"},{"kind":"caret","text":""}]),
            window["parts"].clone(),
        );
        assert_eq!(reply["selectionRedacted"], false, "{reply:?}");
        assert_eq!(reply["selectedText"], "First line\nSecond line");
    }
    /// An open edge is cut where the provider's text closes a sentence, and a break put back
    /// goes back only inside the text kept, where the provider put the start.
    #[test]
    fn a_put_back_break_goes_back_inside_the_text_kept() {
        let reply = call(
            json!({"caretWindow":{"parts":["Cut words. First line","","Second"],"startKnown":false,"endKnown":true,"paragraphStarts":[4, 21]}}),
        );
        assert_eq!(reply["parts"], json!([". First line\n", "", "Second"]));
    }
    /// The paragraph starts already say whether one starts at the caret: a caret window takes
    /// them or what starts at the caret, never both.
    #[test]
    fn a_caret_window_takes_paragraph_starts_or_caret_starts_never_both() {
        let request = json!({"caretWindow":{"parts":["Words","","More words"],"startKnown":true,"endKnown":true,"caretStarts":{"paragraph":true,"line":false,"lineText":null},"paragraphStarts":[3]}});
        assert_eq!(process(&serde_json::to_vec(&request).unwrap()), Err(1));
    }
    #[test]
    fn caret_window_never_returns_a_partial_selection_at_an_open_edge() {
        let reply = call(
            json!({"caretWindow":{"parts":["unknown","secret. visible"," after"],"startKnown":false,"endKnown":true}}),
        );
        assert_eq!(reply["parts"][1], privacy::PLACEHOLDER);
        assert_eq!(reply["selectionUnavailable"], true);
        let empty = call(
            json!({"caretWindow":{"parts":["unknown","","tail"],"startKnown":false,"endKnown":false}}),
        );
        assert_eq!(empty["parts"], json!(["", "", ""]));
        assert_eq!(empty["selectionUnavailable"], false);
    }
    #[test]
    fn withheld_caret_does_not_present_distant_source_as_adjacent_context() {
        let reply = call(
            json!({"caretWindow":{"parts":["Visible. unfinished","","token"],"startKnown":true,"endKnown":false}}),
        );
        assert_eq!(reply["parts"], json!(["", "", ""]));
        assert_eq!(reply["selectionUnavailable"], false);
    }
    #[test]
    fn unavailable_selection_cannot_erase_a_secret_prefix_needed_by_the_after_side() {
        let reply = call(
            json!({"caretWindow":{"parts":["unknown","fragment. password=","syntheticSecret123"],"startKnown":false,"endKnown":true}}),
        );
        assert_eq!(reply["parts"], json!(["", privacy::PLACEHOLDER, ""]));
        assert_eq!(reply["selectionUnavailable"], true);
    }
    #[test]
    fn caret_window_retains_both_large_recognition_sides_until_redaction() {
        let parts = json!(["x".repeat(SCREEN), "selected", "y".repeat(SCREEN)]);
        let reply = call(json!({"caretWindow":{"parts":parts,"startKnown":true,"endKnown":true}}));
        assert_eq!(reply["parts"], parts);
        assert_eq!(reply["selectionUnavailable"], false);
    }
    #[test]
    fn caret_window_requires_actual_source_edge_facts() {
        assert!(
            process(&serde_json::to_vec(&json!({"caretWindow":{"parts":["","",""]}})).unwrap())
                .is_err()
        );
    }
    #[test]
    fn recognition_halo_does_not_consume_the_presentation_reservation() {
        let parts = json!(["x".repeat(SCREEN), "selected", "y".repeat(SCREEN)]);
        let reserved = call(json!({"reserveCaret":parts}));
        assert_eq!(reserved["used"], 4_000 + 8 + 6);
        assert_eq!(reserved["budgetFull"], false);
        let reply = call(json!({"blocks":[{"kind":"field","text":"visible"}],"caret":parts}));
        assert_eq!(
            reply["caret"],
            json!(["x".repeat(2_000), "selected", "y".repeat(2_000)])
        );
        assert_eq!(reply["blocks"][0]["text"], "visible");
    }
    #[test]
    fn recognition_halo_is_redacted_before_nearest_context_is_selected() {
        let before = format!("password={}syntheticSecret123", " ".repeat(SCREEN - 40));
        let reply = call(json!({"blocks":[],"caret":[before,"","Visible. ".repeat(5_000)]}));
        assert!(
            !reply["caret"][0]
                .as_str()
                .unwrap()
                .contains("syntheticSecret123")
        );
        assert!(
            reply["caret"][0]
                .as_str()
                .unwrap()
                .contains(privacy::PLACEHOLDER)
        );
    }
    #[test]
    fn full_selection_and_each_source_side_have_independent_finite_bounds() {
        let selection = "s".repeat(SCREEN - 6);
        let parts = json!(["x".repeat(SCREEN), selection, "y".repeat(SCREEN)]);
        let reserved = call(json!({"reserveCaret":parts}));
        assert_eq!(reserved["used"], SCREEN);
        let reply = call(json!({"blocks":[],"caret":parts}));
        assert_eq!(reply["caret"], json!(["", selection, ""]));
        for parts in [
            json!(["x".repeat(SCREEN + 1), "", ""]),
            json!(["", "", "y".repeat(SCREEN + 1)]),
            json!(["", "s".repeat(SCREEN - 5), ""]),
        ] {
            assert!(process(&serde_json::to_vec(&json!({"reserveCaret":parts})).unwrap()).is_err());
        }
    }
    #[test]
    fn admission_preserves_complete_source_and_returns_the_common_stop_decision() {
        let reserved = call(json!({"reserveCaret":["left","selected","right"]}));
        assert_eq!(reserved["used"], 4 + 8 + 5 + 6);
        let input = format!("{} token=syntheticSecret123", "x".repeat(SCREEN - 30));
        let reply = call(json!({"admit":input,"used":reserved["used"]}));
        assert_eq!(reply["text"], input);
        assert_eq!(reply["budgetFull"], true);
        assert_eq!(reply["stop"], "text budget");
        let next = call(json!({"admit":"must not be admitted","used":reply["used"]}));
        assert_eq!(next["text"], "");
        assert_eq!(next["budgetFull"], true);
        assert_eq!(next["stop"], "text budget");
        let field = call(json!({"admitField":["a","b","c"],"used":SCREEN - 1}));
        assert_eq!(field["stop"], "text budget");
        let open = call(json!({"admitField":["a","b","c"],"used":0}));
        assert_eq!(open["stop"], Value::Null);
        // The budget is full, and the read stops, at exactly its last byte.
        let last = call(json!({"admit":"a","used":SCREEN - 1}));
        assert_eq!(
            (last["used"].as_u64(), &last["stop"]),
            (Some(SCREEN as u64), &json!("text budget"))
        );
        let short = call(json!({"admit":"a","used":SCREEN - 2}));
        assert_eq!(short["stop"], Value::Null);
    }
    /// The refusal a helper sends for a caret it could not read with text selected is the core's:
    /// no text around the caret and the redaction marker as the selection, which disables Edit.
    #[test]
    fn an_unavailable_caret_is_the_cores_refusal() {
        let reply = call(json!({"caretUnread":{"selectsText":true}}));
        let limits = call(json!({"limits":true}));
        assert_eq!(limits["redactedMarker"], privacy::PLACEHOLDER);
        assert_eq!(
            reply,
            json!({"parts":["",limits["redactedMarker"],""],"selectionUnavailable":true})
        );
        let request = json!({
            "appName":"Synthetic editor","exclusions":{"excludedAppIDs":[],"excludedHosts":[]},
            "nodes":1,"milliseconds":1,"selectionUnavailable":reply["selectionUnavailable"],
            "blocks":[{"kind":"caret","text":""}],"caret":reply["parts"]
        });
        let rendered: Value = serde_json::from_slice(
            &crate::screen::process(&serde_json::to_vec(&request).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(rendered["selectionRedacted"], true);
    }
    #[test]
    fn admission_skips_canonical_adjacent_duplicates_without_spending_budget() {
        let reply = call(json!({"admit":" e\u{301} ","previous":"é","used":17}));
        assert_eq!(
            reply,
            json!({"text":"","used":17,"budgetFull":false,"stop":null})
        );
    }
    #[test]
    fn caret_is_reserved_once_even_when_its_block_is_late() {
        let reply = call(json!({"blocks":[{"kind":"field","text":"x".repeat(SCREEN)},
            {"kind":"caret","text":"ignored duplicate source"}],"caret":["left","chosen","right"]}));
        let blocks = reply["blocks"].as_array().unwrap();
        assert_eq!(reply["caret"], json!(["left", "chosen", "right"]));
        assert_eq!(blocks[1]["text"], "left‸chosen‸right");
        assert_eq!(
            blocks
                .iter()
                .map(|b| b["text"].as_str().unwrap().len())
                .sum::<usize>(),
            SCREEN
        );
        assert_eq!(reply["truncated"], true);
    }
    #[test]
    fn hidden_text_at_a_link_edge_is_never_glued_to_a_key_beside_it() {
        let key = format!("{}{}", "AKIA", "A".repeat(16));
        let before = json!([
            {"kind":"text","text":format!("Key {key}"),"frame":[20,0,200,20]},
            {"kind":"link","text":"(docs)","runs":[["zz",false],["(docs)",true]],"frame":[220,0,40,20]}
        ]);
        let after = json!([
            {"kind":"link","text":"(docs)","runs":[["(docs)",true],["zz",false]],"frame":[20,0,40,20]},
            {"kind":"text","text":format!("{key} here"),"frame":[60,0,240,20]}
        ]);
        let glued: Vec<_> = [("before", before), ("after", after)]
            .into_iter()
            .filter(|(_, blocks)| {
                let reply = call(json!({"blocks":blocks,"caret":["","",""]}));
                let rendered = reply["rendered"].as_str().unwrap();
                rendered.contains("AKIA") || !rendered.contains("[redacted]")
            })
            .map(|(side, _)| side)
            .collect();
        assert!(glued.is_empty(), "a key shown beside a link: {glued:?}");
    }
    #[test]
    fn final_semantic_prefix_follows_redaction_and_keeps_graphemes_whole() {
        let text = format!("{} {}{}", "x".repeat(19_994), "AKIA", "A".repeat(16));
        let reply = call(json!({"blocks":[{"kind":"row","text":text}],"caret":["","",""]}));
        let shown = reply["blocks"][0]["text"].as_str().unwrap();
        assert!(!shown.contains("AKIA"));
        assert!(shown.graphemes(true).count() <= 20_000);
        assert_eq!(reply["truncated"], true);
        let family = "👨‍👩‍👧‍👦";
        let reply = call(
            json!({"blocks":[{"kind":"field","text":family.repeat(10_486)}],"caret":["","",""]}),
        );
        let shown = reply["blocks"][0]["text"].as_str().unwrap();
        assert!(shown.graphemes(true).all(|g| g == family));
        assert!(shown.len() <= SCREEN - "‸".len());
    }
    #[test]
    fn row_limit_does_not_leave_an_incomplete_join_separator() {
        for padding in [19_997, 19_998, 19_999] {
            let text = format!("{} | next", "x".repeat(padding));
            let reply = call(json!({"blocks":[{"kind":"row","text":text}]}));
            assert_eq!(reply["blocks"][0]["text"], "x".repeat(padding));
        }
    }
    #[test]
    fn large_selection_refuses_instead_of_becoming_a_different_edit_target() {
        let request = json!({"blocks":[],"caret":["","x".repeat(SCREEN),""]});
        assert!(process(&serde_json::to_vec(&request).unwrap()).is_err());
        let duplicate = json!({"blocks":[{"kind":"caret","text":"a"},{"kind":"caret","text":"b"}],"caret":["","",""]});
        assert!(process(&serde_json::to_vec(&duplicate).unwrap()).is_err());
    }
    #[test]
    fn caret_context_retains_the_nearest_shared_graphemes() {
        let reply = call(
            json!({"blocks":[],"caret":[format!("old{}", "é".repeat(2_000)),"chosen",format!("{}old", "👨‍👩‍👧‍👦".repeat(2_000))]}),
        );
        assert_eq!(
            reply["caret"],
            json!(["é".repeat(2_000), "chosen", "👨‍👩‍👧‍👦".repeat(2_000)])
        );
        assert_eq!(reply["selectionRedacted"], false);
        assert_eq!(reply["truncated"], true);
    }
    #[test]
    fn field_recognition_context_is_redacted_before_visible_projection() {
        let request = json!({"blocks":[{"kind":"field","text":"syntheticSecret123", "source":["Offscreen heading. password: ","syntheticSecret123",". Offscreen footer"]}], "caret":["","",""]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert_eq!(result["blocks"][0]["text"], privacy::PLACEHOLDER);
        assert_eq!(result["rendered"], "> [redacted]");
        assert!(result["blocks"][0].get("source").is_none());
    }
    #[test]
    fn field_projection_preserves_raw_whitespace_until_combined_redaction() {
        let request = json!({"blocks":[{"kind":"field","text":" syntheticSecret123", "source":["Bearer"," syntheticSecret123",". "]}], "caret":["","",""]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert!(
            !result["rendered"]
                .as_str()
                .unwrap()
                .contains("syntheticSecret123")
        );
    }
    #[test]
    fn field_source_is_not_rendered_even_without_a_caret_request() {
        let request = json!({"blocks":[{"kind":"field","text":"Visible", "source":["Private prefix. ","Visible",". Private suffix"]}]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert_eq!(result["rendered"], "> Visible");
        assert!(result["blocks"][0].get("source").is_none());
    }
    #[test]
    fn field_source_requires_matching_target_and_bounded_parts() {
        for source in [
            json!(["a", "different", "b"]),
            json!(["target"]),
            json!(["a", 3, "b"]),
            json!(["x".repeat(SOURCE_WINDOW_BYTES + 1), "target", ""]),
        ] {
            let request = json!({"blocks":[{"kind":"field","text":"target","source":source}],"caret":["","",""]});
            assert!(process(&serde_json::to_vec(&request).unwrap()).is_err());
        }
    }
    #[test]
    fn field_source_admission_charges_all_private_bytes_without_normalizing_parts() {
        let parts = json!(["Bearer", " syntheticSecret123", ". "]);
        let result: Value = serde_json::from_slice(
            &process(&serde_json::to_vec(&json!({"admitField":parts,"used":0})).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(result["parts"], parts);
        assert_eq!(result["used"], "Bearer syntheticSecret123. ".len());
        let result: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(&json!({"admitField":["a","visible","b"],"used":SCREEN_BYTES}))
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["parts"], json!(["", "", ""]));
        assert_eq!(result["used"], SCREEN_BYTES);
    }
    #[test]
    fn semantic_runs_redact_private_source_and_preserve_visible_joiners() {
        let request = json!({"blocks":[{"kind":"row","text":"Label | syntheticSecret123",
            "runs":[["Label | ",true],["password: ",false],["syntheticSecret123",true]]}]});
        let result: Value =
            serde_json::from_slice(&process(&serde_json::to_vec(&request).unwrap()).unwrap())
                .unwrap();
        assert_eq!(result["rendered"], "| Label | [redacted]");
        assert!(result["blocks"][0].get("runs").is_none());
    }
    #[test]
    fn semantic_admission_deduplicates_only_equivalent_recognition_source() {
        let value = json!({"kind":"row","text":"same","runs":[["password: ",false],["same",true]]});
        let admit = |previous| -> Value {
            serde_json::from_slice(
                &process(
                    &serde_json::to_vec(
                        &json!({"admitSemantic":value,"used":10,"previous":previous}),
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(admit(value.clone())["text"], "");
        assert_eq!(
            admit(json!({"kind":"row","text":"same","runs":[["public ",false],["same",true]]}))["text"],
            "same"
        );
        assert_eq!(admit(json!({"kind":"text","text":"same"}))["text"], "same");
        let plain = json!({"kind":"row","text":"same","runs":[["same",true]]});
        let result: Value = serde_json::from_slice(&process(&serde_json::to_vec(&json!({"admitSemantic":plain,"used":10,"previous":{"kind":"text","text":"same"}})).unwrap()).unwrap()).unwrap();
        assert_eq!(result["text"], "");
        // A text admitted with the screen's edge spaces, and a link holding them as hidden runs,
        // still repeat the same words.
        let spaced =
            json!({"kind":"link","text":"same","runs":[[" ",false],["same",true],[" ",false]]});
        for previous in [
            json!({"kind":"text","text":" same "}),
            json!({"kind":"text","text":"same"}),
        ] {
            let result: Value = serde_json::from_slice(
                &process(
                    &serde_json::to_vec(
                        &json!({"admitSemantic":spaced,"used":10,"previous":previous}),
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(result["text"], "");
        }
        let result: Value = serde_json::from_slice(&process(&serde_json::to_vec(&json!({"admitSemantic":plain,"used":10,"previous":{"kind":"text","text":" same "}})).unwrap()).unwrap()).unwrap();
        assert_eq!(result["text"], "");
        let result: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(&json!({"admitSemantic":plain,"used":10,"previous":spaced}))
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["text"], "");
        // A hidden run that is more than spaces is private source, not a repeat.
        let private = json!({"kind":"link","text":"same","runs":[[" x",false],["same",true]]});
        let result: Value = serde_json::from_slice(&process(&serde_json::to_vec(&json!({"admitSemantic":private,"used":10,"previous":{"kind":"text","text":"same"}})).unwrap()).unwrap()).unwrap();
        assert_eq!(result["text"], "same");
    }
    #[test]
    fn semantic_admission_charges_private_bytes_and_stops_further_sources() {
        let block = json!({"kind":"row","text":"visible","runs":[["x".repeat(SOURCE_WINDOW_BYTES),false],["visible",true]]});
        let admit = |used| -> Value {
            serde_json::from_slice(
                &process(&serde_json::to_vec(&json!({"admitSemantic":block,"used":used})).unwrap())
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(admit(0)["used"], SOURCE_WINDOW_BYTES + 7);
        assert_eq!(admit(0)["budgetFull"], true);
        assert_eq!(admit(SCREEN_BYTES)["runs"], json!([]));
        assert_eq!(admit(SCREEN_BYTES)["used"], SCREEN_BYTES);
        let invalid = json!({"blocks":[{"kind":"row","text":"", "runs":vec![("x".repeat(SOURCE_WINDOW_BYTES),false);5]}]});
        assert!(process(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    #[test]
    fn semantic_run_metadata_is_validated_not_ignored() {
        for runs in [
            json!([["different", true]]),
            json!([["text", 1]]),
            json!([["text", true, "extra"]]),
        ] {
            let request = json!({"blocks":[{"kind":"heading","text":"text","runs":runs}]});
            assert!(process(&serde_json::to_vec(&request).unwrap()).is_err());
        }
    }
    #[test]
    fn ordinary_block_window_and_probes_share_the_screen_source_allowance() {
        let text = "x".repeat(300_000);
        let result: Value = serde_json::from_slice(
            &process(
                &serde_json::to_vec(
                    &json!({"blockWindow":{"text":text,"startKnown":true,"endKnown":true}}),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["text"], text);
        let probes: Value =
            serde_json::from_slice(&process(br#"{"opaqueProbes":true,"scope":"block"}"#).unwrap())
                .unwrap();
        assert_eq!(probes["amounts"][0], BLOCK_SOURCE_BYTES);
        assert!(process(br#"{"opaqueProbes":true,"scope":"unknown"}"#).is_err());
    }
    #[test]
    fn opaque_field_window_keeps_projection_and_withholds_unknown_edges() {
        let project = |parts, start, end| -> Value {
            serde_json::from_slice(
                &process(
                    &serde_json::to_vec(
                        &json!({"fieldWindow":{"parts":parts,"startKnown":start,"endKnown":end}}),
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            project(json!(["password: ", "syntheticSecret123", ""]), true, true)["parts"],
            json!(["password: ", "syntheticSecret123", ""])
        );
        assert_eq!(
            project(
                json!(["unknown", "Secret123. Visible! ", "tail"]),
                false,
                false
            )["parts"],
            json!(["", ". Visible! ", ""])
        );
        assert!(
            process(&serde_json::to_vec(&json!({"fieldWindow":{"parts":["","x",""]}})).unwrap())
                .is_err()
        );
    }
    #[test]
    fn field_ranges_preserve_hidden_gaps_and_reject_invalid_metadata() {
        let ranges = |count, ranges| {
            process(
                &serde_json::to_vec(&json!({"fieldRanges":{"count":count,"ranges":ranges}}))
                    .unwrap(),
            )
        };
        let value: Value = serde_json::from_slice(
            &ranges(
                100,
                json!([[40, 50], [10, 20], [18, 30], [30, 35], [0, 0], [40, 45]]),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["ranges"], json!([[10, 35], [40, 50]]));
        for invalid in [
            json!([[-1, 1]]),
            json!([[2, 1]]),
            json!([[0, 101]]),
            json!([[0, 1.5]]),
            json!([[0, 1, 2]]),
        ] {
            assert!(ranges(100, invalid).is_err());
        }
        assert!(ranges(100, json!(vec![[0, 1]; 65])).is_err());
        assert!(ranges(100, json!([])).is_ok());
    }
    #[test]
    fn field_plan_separates_native_lower_bound_from_grapheme_eligibility() {
        let plan = |value| -> Value {
            serde_json::from_slice(
                &process(&serde_json::to_vec(&json!({"fieldPlan":value})).unwrap()).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            plan(json!({"count":SOURCE_WINDOW_BYTES+1}))["probeWhole"],
            false
        );
        assert_eq!(
            plan(json!({"count":SOURCE_WINDOW_BYTES}))["probeWhole"],
            true
        );
        assert_eq!(plan(json!({}))["probeWhole"], true);
        assert_eq!(plan(json!({"text":"😀".repeat(15000)}))["useWhole"], true);
        assert_eq!(plan(json!({"text":"x".repeat(20001)}))["useWhole"], false);
        assert_eq!(
            plan(json!({"text":"e\u{301}".repeat(20000)}))["useWhole"],
            true
        );
        for value in [
            json!(false),
            json!({"count":-1}),
            json!({"count":1.5}),
            json!({"text":3}),
        ] {
            assert!(process(&serde_json::to_vec(&json!({"fieldPlan":value})).unwrap()).is_err());
        }
    }
    #[test]
    fn standalone_field_projection_redacts_and_requires_caret_parts_when_present() {
        let block = json!({"kind":"field","text":"syntheticSecret123","source":["password: ","syntheticSecret123",""]});
        let result: Value = serde_json::from_slice(
            &process(&serde_json::to_vec(&json!({"blocks":[block.clone()]})).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(result["rendered"], "> [redacted]");
        assert!(
            process(
                &serde_json::to_vec(&json!({"blocks":[block,{"kind":"caret","text":"raw caret"}]}))
                    .unwrap()
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod hypertext_tests {
    use super::*;

    const OBJECT: &str = "\u{FFFC}";
    const BREAK: char = LINE_BREAK;

    fn element(text: &str, block: bool, links: Value) -> Value {
        json!({"text": text, "caret": null, "selection": null, "block": block, "links": links})
    }
    fn join(elements: &[Value]) -> Result<Value, u32> {
        process(&serde_json::to_vec(&json!({"hypertext": {"elements": elements}})).unwrap())
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
    fn before(reply: &Value) -> String {
        let caret = reply["caret"].as_u64().unwrap() as usize;
        reply["text"]
            .as_str()
            .unwrap()
            .chars()
            .take(caret)
            .collect()
    }
    fn selected(reply: &Value) -> String {
        let range = &reply["selection"];
        let (start, end) = (
            range[0].as_u64().unwrap() as usize,
            range[1].as_u64().unwrap() as usize,
        );
        reply["text"]
            .as_str()
            .unwrap()
            .chars()
            .skip(start)
            .take(end - start)
            .collect()
    }
    /// Chromium's paragraphs: each a block element at an object of the editor's text, an empty
    /// line one whose text is the `<br>`'s `\n`.
    fn paragraphs() -> Vec<Value> {
        let lines = ["Hi All,", "\n", "Why does it move?", "\n", "--"];
        let links: Vec<Value> = (0..lines.len()).map(|i| json!([i, i + 1])).collect();
        let mut elements = vec![element(&OBJECT.repeat(lines.len()), true, json!(links))];
        elements.extend(lines.iter().map(|line| element(line, true, json!([]))));
        elements
    }

    #[test]
    fn paragraphs_join_with_the_cores_breaks() {
        let reply = join(&paragraphs()).unwrap();
        assert_eq!(
            reply["text"],
            format!("Hi All,{BREAK}\nWhy does it move?{BREAK}\n--")
        );
        assert_eq!(reply["caret"], Value::Null);
        assert_eq!(reply["selection"], Value::Null);
    }

    /// A caret on the empty line follows the paragraph's break; inside a paragraph it is placed by
    /// the paragraph, not by the editor's caret at its object.
    #[test]
    fn a_paragraphs_own_caret_places_it() {
        let mut empty = paragraphs();
        empty[4]["caret"] = json!(0);
        assert_eq!(
            before(&join(&empty).unwrap()),
            format!("Hi All,{BREAK}\nWhy does it move?{BREAK}")
        );
        let mut inner = paragraphs();
        inner[0]["caret"] = json!(2);
        inner[3]["caret"] = json!(4);
        assert_eq!(
            before(&join(&inner).unwrap()),
            format!("Hi All,{BREAK}\nWhy ")
        );
    }

    /// A caret at an object whose element reports none is before that element: a link's text, and
    /// a paragraph's line.
    #[test]
    fn a_caret_at_an_object_with_none_of_its_own_is_before_it() {
        let link = [
            json!({"text": format!("ab{OBJECT}cd"), "caret": 2, "selection": null, "block": true, "links": [[2, 1]]}),
            element("link", false, json!([])),
        ];
        let reply = join(&link).unwrap();
        assert_eq!(reply["text"], "ablinkcd");
        assert_eq!(before(&reply), "ab");
        let mut paragraph = paragraphs();
        paragraph[0]["caret"] = json!(2);
        assert_eq!(
            before(&join(&paragraph).unwrap()),
            format!("Hi All,{BREAK}\n")
        );
    }

    /// A selection from a paragraph's end (Chromium gives that paragraph no part, or an empty one,
    /// and the editor the paragraph's object) starts there; one down to the next paragraph's start,
    /// the caret there, holds the break.
    #[test]
    fn a_selection_at_a_paragraphs_edge_keeps_the_break_chromium_means() {
        let two = |range: [usize; 2]| {
            vec![
                json!({"text": OBJECT.repeat(3), "caret": null, "selection": range, "block": true,
                    "links": [[0, 1], [1, 2], [2, 3]]}),
                element("Hi All,", true, json!([])),
                element("Why does it move?", true, json!([])),
                element("--", true, json!([])),
            ]
        };
        let mut from_end = two([0, 2]);
        from_end[2]["selection"] = json!([0, 3]);
        assert_eq!(selected(&join(&from_end).unwrap()), format!("{BREAK}Why"));
        from_end[1]["selection"] = json!([7, 7]);
        assert_eq!(selected(&join(&from_end).unwrap()), format!("{BREAK}Why"));
        assert_eq!(selected(&join(&two([0, 1])).unwrap()), BREAK.to_string());
        let mut down = two([1, 2]);
        down[2]["selection"] = json!([0, 17]);
        down[3]["caret"] = json!(0);
        assert_eq!(
            selected(&join(&down).unwrap()),
            format!("Why does it move?{BREAK}")
        );
        // Only the caret at the next paragraph's start: elsewhere in it, the break is not selected.
        down[3]["caret"] = json!(1);
        assert_eq!(selected(&join(&down).unwrap()), "Why does it move?");
        down[3]["caret"] = Value::Null;
        down[2]["caret"] = json!(17);
        assert_eq!(selected(&join(&down).unwrap()), "Why does it move?");
    }

    /// A link the helper did not go into is read as the text it is: a label's inline link, and an
    /// object leading back into the read.
    #[test]
    fn a_link_not_gone_into_is_its_text() {
        let label = [element("Visit example.com now", false, json!([[6, null]]))];
        assert_eq!(join(&label).unwrap()["text"], "Visit example.com now");
        let back = [
            element(&format!("a{OBJECT}b"), false, json!([[1, 1]])),
            element(&format!("c{OBJECT}"), false, json!([[1, null]])),
        ];
        assert_eq!(join(&back).unwrap()["text"], format!("ac{OBJECT}b"));
    }

    /// The elements must be the ones the text holds, each once, in its order, within the budgets.
    #[test]
    fn elements_the_text_does_not_hold_are_refused() {
        // A link outside its element's text.
        assert_eq!(join(&[element("ab", false, json!([[5, null]]))]), Err(1));
        // An element at a character that is no object.
        assert_eq!(
            join(&[
                element("ab", false, json!([[0, 1]])),
                element("x", true, json!([]))
            ]),
            Err(1)
        );
        // Two links to one element, out of order, or one never reached.
        let twice = [
            element(&OBJECT.repeat(2), false, json!([[0, 1], [1, 1]])),
            element("x", true, json!([])),
        ];
        assert_eq!(join(&twice), Err(1));
        let swapped = [
            element(&OBJECT.repeat(2), false, json!([[0, 2], [1, 1]])),
            element("x", true, json!([])),
            element("y", true, json!([])),
        ];
        assert_eq!(join(&swapped), Err(1));
        let unread = [
            element("ab", false, json!([])),
            element("x", true, json!([])),
        ];
        assert_eq!(join(&unread), Err(1));
        assert_eq!(join(&[]), Err(1));
        // More elements or text than a helper may read.
        let many: Vec<Value> = std::iter::once(element(
            &OBJECT.repeat(CARET_SOURCE_ELEMENTS),
            false,
            json!(
                (0..CARET_SOURCE_ELEMENTS)
                    .map(|i| json!([i, i + 1]))
                    .collect::<Vec<_>>()
            ),
        ))
        .chain((0..CARET_SOURCE_ELEMENTS).map(|_| element("x", true, json!([]))))
        .collect();
        assert_eq!(join(&many), Err(1));
        let fits: Vec<Value> = std::iter::once(element(
            &OBJECT.repeat(CARET_SOURCE_ELEMENTS - 1),
            false,
            json!(
                (0..CARET_SOURCE_ELEMENTS - 1)
                    .map(|i| json!([i, i + 1]))
                    .collect::<Vec<_>>()
            ),
        ))
        .chain((0..CARET_SOURCE_ELEMENTS - 1).map(|_| element("x", true, json!([]))))
        .collect();
        assert!(join(&fits).is_ok());
        assert_eq!(
            join(&[element(
                &"a".repeat(CARET_SOURCE_BYTES + 1),
                false,
                json!([])
            )]),
            Err(1)
        );
        assert_eq!(process(br#"{"hypertext":{}}"#), Err(1));
    }
    /// The elements' text, objects included, is held to the budget, though the joined text,
    /// without the objects, fits it.
    #[test]
    fn the_elements_text_is_held_to_the_budget() {
        let children = 299;
        let elements = |total: usize| {
            let own = OBJECT.len() * children;
            let each = (total - own) / children;
            let links: Vec<Value> = (0..children).map(|i| json!([i, i + 1])).collect();
            let mut elements = vec![element(&OBJECT.repeat(children), false, json!(links))];
            for i in 0..children {
                let size = if i + 1 == children {
                    total - own - each * (children - 1)
                } else {
                    each
                };
                elements.push(element(&"a".repeat(size), false, json!([])));
            }
            elements
        };
        let fits = join(&elements(CARET_SOURCE_BYTES)).unwrap();
        assert_eq!(
            fits["text"].as_str().unwrap().len(),
            CARET_SOURCE_BYTES - OBJECT.len() * children
        );
        assert_eq!(join(&elements(CARET_SOURCE_BYTES + 1)), Err(1));
    }
}
