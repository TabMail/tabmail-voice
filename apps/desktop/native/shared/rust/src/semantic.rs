// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_GRAPHEMES: usize = 20_000;
pub const MAX_BYTES: usize = 256 * 1024;
pub const MAX_RUNS: usize = 30_001;
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum Decision {
    Root = 1,
    Descendants = 2,
    Complete = 3,
    BudgetFull = 4,
}
/// Keeps approved source text intact until the final combined-screen redaction.
/// A budget stop prevents further provider reads; it is not a pre-redaction cut.
/// At most one final fragment can exceed the presentation budget, so retained
/// joined text is bounded by twice MAX_BYTES plus one separator.
pub struct SemanticText {
    kind: u32,
    decision: Decision,
    text: String,
    previous: String,
    graphemes: usize,
    last_grapheme: usize,
    failed: bool,
    runs: Vec<(String, bool)>,
    source_bytes: usize,
    projected: bool,
    previous_projection: Option<Vec<String>>,
    /// Whether the first text kept started with a space and the last one ended with one: the
    /// screen shows them (a link's box holds the space before or after it), so the screen read
    /// can tell a link from the word it abuts.
    spaced: [bool; 2],
}
impl SemanticText {
    pub fn new(kind: u32) -> Result<Self, u32> {
        if !(1..=3).contains(&kind) {
            return Err(1);
        }
        Ok(Self {
            kind,
            decision: if kind == 1 {
                Decision::Descendants
            } else {
                Decision::Root
            },
            text: String::new(),
            previous: String::new(),
            graphemes: 0,
            last_grapheme: 0,
            failed: false,
            runs: Vec::new(),
            source_bytes: 0,
            projected: false,
            previous_projection: None,
            spaced: [false; 2],
        })
    }
    pub fn decision(&self) -> Decision {
        self.decision
    }
    pub fn refuse(&mut self) {
        self.failed = true;
        self.text.clear();
        self.previous.clear();
        self.runs.clear();
        self.previous_projection = None;
    }
    pub fn offer(&mut self, event: u32, text: &str) -> Result<Decision, u32> {
        if self.failed
            || text.len() > MAX_BYTES
            || !matches!(
                (self.decision, event),
                (Decision::Root, 1) | (Decision::Descendants, 2..=4)
            )
            || (event >= 3 && !text.is_empty())
        {
            self.refuse();
            return Err(1);
        }
        self.previous_projection = None;
        if event >= 3 {
            self.decision = if event == 3 && self.kind == 1 && self.text.is_empty() {
                Decision::Root
            } else {
                Decision::Complete
            };
        } else {
            self.append(text);
            if self.graphemes >= MAX_GRAPHEMES
                || self.source_bytes >= MAX_BYTES
                || self.runs.len() >= MAX_RUNS - 6
            {
                self.decision = Decision::BudgetFull;
            } else if event == 1 {
                self.decision = if self.kind != 1 && self.text.is_empty() {
                    Decision::Descendants
                } else {
                    Decision::Complete
                };
            }
        }
        Ok(self.decision)
    }
    fn append(&mut self, source: &str) {
        let text = source.trim_matches(crate::context::whitespace);
        if text.is_empty() || self.previous.nfd().eq(text.nfd()) {
            return;
        }
        if self.text.is_empty() {
            self.spaced[0] = source.starts_with(crate::context::whitespace);
        }
        self.spaced[1] = source.ends_with(crate::context::whitespace);
        let boundary = self.last_grapheme;
        if !self.text.is_empty() {
            let separator = if self.kind == 1 { " | " } else { " " };
            self.text.push_str(separator);
            self.runs.push((separator.to_owned(), true));
            self.source_bytes += separator.len();
        }
        self.text.push_str(text);
        self.runs.push((text.to_owned(), true));
        self.source_bytes += text.len();
        // Re-segment only the previous final cluster and the newly joined suffix.
        // This handles combining/prepend characters across fragment boundaries.
        let mut count = 0;
        for (offset, _) in self.text[boundary..].grapheme_indices(true) {
            count += 1;
            self.last_grapheme = boundary + offset;
        }
        self.graphemes = self.graphemes.saturating_sub(1) + count;
        self.previous.clear();
        self.previous.push_str(text);
    }
    pub fn offer_projected(&mut self, event: u32, parts: Vec<String>) -> Result<Decision, u32> {
        if parts.len() != 3 || parts.iter().any(|p| p.len() > MAX_BYTES) || !matches!(event, 1 | 2)
        {
            self.refuse();
            return Err(1);
        }
        let visible = parts[1].trim_matches(crate::context::whitespace);
        // Equal display text with different private source is not a duplicate.
        if self.previous_projection.as_ref() != Some(&parts) {
            self.previous.clear();
        }
        let prior_runs = self.runs.len();
        self.offer(event, visible)?;
        if self.runs.len() > prior_runs {
            self.runs.pop(); // Replace the normalized display fragment with mapped source.
            let start = parts[1].len()
                - parts[1]
                    .trim_start_matches(crate::context::whitespace)
                    .len();
            let end = start + visible.len();
            for (text, shown) in [
                (&parts[0][..], false),
                (&parts[1][..start], false),
                (visible, true),
                (&parts[1][end..], false),
                (&parts[2][..], false),
            ] {
                if !text.is_empty() {
                    self.runs.push((text.to_owned(), shown));
                }
            }
            self.source_bytes += parts.iter().map(String::len).sum::<usize>() - visible.len();
            self.projected = true;
            if self.source_bytes >= MAX_BYTES || self.runs.len() >= MAX_RUNS - 6 {
                self.decision = Decision::BudgetFull;
            }
        }
        self.previous_projection = Some(parts);
        Ok(self.decision)
    }
    /// The text and its runs, with a space the screen shows at either edge as a hidden run.
    pub fn finish_projected(&self) -> Result<Vec<u8>, u32> {
        let edge = |spaced: bool| spaced.then(|| (" ".to_owned(), false));
        let runs: Vec<_> = edge(self.spaced[0])
            .into_iter()
            .chain(self.runs.iter().cloned())
            .chain(edge(self.spaced[1]))
            .collect();
        if self.failed
            || !matches!(self.decision, Decision::Complete | Decision::BudgetFull)
            || self.source_bytes + runs.len() - self.runs.len()
                > crate::context::SEMANTIC_SOURCE_BYTES
            || runs.len() > MAX_RUNS
        {
            return Err(1);
        }
        serde_json::to_vec(&serde_json::json!({"text":self.text,"runs":runs})).map_err(|_| 3)
    }
    pub fn finish(&self) -> Result<&str, u32> {
        if self.failed
            || self.projected
            || !matches!(self.decision, Decision::Complete | Decision::BudgetFull)
        {
            Err(1)
        } else {
            Ok(&self.text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_space_at_the_edge_of_the_text_is_a_hidden_run() {
        let runs = |offers: &[(u32, &str)]| {
            let mut link = SemanticText::new(2).unwrap();
            for (event, text) in offers {
                link.offer(*event, text).unwrap();
            }
            let result: serde_json::Value =
                serde_json::from_slice(&link.finish_projected().unwrap()).unwrap();
            result["runs"].clone()
        };
        assert_eq!(
            runs(&[(1, " Read more\t")]),
            serde_json::json!([[" ", false], ["Read more", true], [" ", false]])
        );
        // The first text kept and the last: not one dropped as empty or as a repeat.
        assert_eq!(
            runs(&[
                (1, ""),
                (2, "  "),
                (2, " Read"),
                (2, "more"),
                (2, "more "),
                (3, "")
            ]),
            serde_json::json!([[" ", false], ["Read", true], [" ", true], ["more", true]])
        );
        assert_eq!(
            runs(&[(1, ""), (2, "Read"), (2, "more "), (3, "")]),
            serde_json::json!([["Read", true], [" ", true], ["more", true], [" ", false]])
        );
        assert_eq!(runs(&[(1, "Read")]), serde_json::json!([["Read", true]]));
    }
    #[test]
    fn projected_fragments_retain_private_whitespace_and_require_projected_transport() {
        let mut row = SemanticText::new(1).unwrap();
        row.offer(2, "Label").unwrap();
        row.offer_projected(
            2,
            vec![
                "password:".into(),
                " syntheticSecret123 ".into(),
                ". End".into(),
            ],
        )
        .unwrap();
        row.offer(3, "").unwrap();
        assert!(row.finish().is_err());
        let result: serde_json::Value =
            serde_json::from_slice(&row.finish_projected().unwrap()).unwrap();
        assert_eq!(result["text"], "Label | syntheticSecret123");
        let mut block = result;
        block["kind"] = serde_json::json!("row");
        let response: serde_json::Value = serde_json::from_slice(
            &crate::context::process(
                &serde_json::to_vec(&serde_json::json!({"blocks":[block]})).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(response["rendered"], "| Label | [redacted]");
    }
    #[test]
    fn projected_fragment_count_stops_with_a_valid_final_transport() {
        let mut heading = SemanticText::new(2).unwrap();
        heading.offer(1, "").unwrap();
        for index in 0..MAX_RUNS {
            if heading.decision() != Decision::Descendants {
                break;
            }
            heading
                .offer_projected(
                    2,
                    vec![
                        "before".into(),
                        if index % 2 == 0 { " x " } else { " y " }.into(),
                        "after".into(),
                    ],
                )
                .unwrap();
        }
        assert_eq!(heading.decision(), Decision::BudgetFull);
        assert!(heading.runs.len() <= MAX_RUNS);
        assert!(heading.finish_projected().is_ok());
    }
    #[test]
    fn projected_dedup_requires_identical_private_source_and_charges_hidden_bytes() {
        let mut row = SemanticText::new(1).unwrap();
        let parts = vec!["first ".into(), "same".into(), "".into()];
        row.offer_projected(2, parts.clone()).unwrap();
        row.offer_projected(2, parts).unwrap();
        row.offer_projected(2, vec!["different ".into(), "same".into(), "".into()])
            .unwrap();
        row.offer(3, "").unwrap();
        let result: serde_json::Value =
            serde_json::from_slice(&row.finish_projected().unwrap()).unwrap();
        assert_eq!(result["text"], "same | same");
        let mut large = SemanticText::new(1).unwrap();
        assert_eq!(
            large
                .offer_projected(2, vec!["x".repeat(MAX_BYTES), "visible".into(), "".into()])
                .unwrap(),
            Decision::BudgetFull
        );
        assert!(large.offer(2, "must not be read").is_err());
        assert!(large.finish_projected().is_err());
    }
    #[test]
    fn row_prefers_cells_but_empty_complete_row_requests_root() {
        let mut row = SemanticText::new(1).unwrap();
        assert_eq!(row.decision(), Decision::Descendants);
        assert_eq!(row.offer(2, "  Alice  ").unwrap(), Decision::Descendants);
        row.offer(2, "Ready").unwrap();
        assert_eq!(row.offer(3, "").unwrap(), Decision::Complete);
        assert_eq!(row.finish().unwrap(), "Alice | Ready");
        assert_eq!(row.offer(1, "generic row"), Err(1));
        let mut empty = SemanticText::new(1).unwrap();
        empty.offer(2, " ").unwrap();
        assert_eq!(empty.offer(3, "").unwrap(), Decision::Root);
        empty.offer(1, " root only ").unwrap();
        assert_eq!(empty.finish().unwrap(), "root only");
    }
    #[test]
    fn heading_and_link_stop_after_an_approved_nonblank_root() {
        for kind in [2, 3] {
            let mut text = SemanticText::new(kind).unwrap();
            assert_eq!(text.decision(), Decision::Root);
            assert_eq!(
                text.offer(1, "\u{a0}Title\u{200b}").unwrap(),
                Decision::Complete
            );
            assert_eq!(text.finish().unwrap(), "Title");
            assert_eq!(text.offer(2, "must not read"), Err(1));
            let mut blank = SemanticText::new(kind).unwrap();
            assert_eq!(blank.offer(1, "\u{85}").unwrap(), Decision::Descendants);
            blank.offer(2, "one").unwrap();
            blank.offer(2, "two").unwrap();
            blank.offer(3, "").unwrap();
            assert_eq!(blank.finish().unwrap(), "one two");
        }
    }
    #[test]
    fn partial_traversal_never_requests_a_root_fallback() {
        let mut row = SemanticText::new(1).unwrap();
        assert_eq!(row.finish(), Err(1));
        assert_eq!(row.offer(4, "").unwrap(), Decision::Complete);
        assert_eq!(row.finish().unwrap(), "");
    }
    #[test]
    fn canonical_adjacent_duplicates_ignore_empty_fragments_only() {
        let mut row = SemanticText::new(1).unwrap();
        for part in ["é", " ", "e\u{301}", "other", "é"] {
            row.offer(2, part).unwrap();
        }
        row.offer(3, "").unwrap();
        assert_eq!(row.finish().unwrap(), "é | other | é");
    }
    #[test]
    fn budget_stops_reads_but_preserves_final_fragment_for_combined_redaction() {
        for count in [MAX_GRAPHEMES, MAX_GRAPHEMES + 1] {
            let mut row = SemanticText::new(1).unwrap();
            let input = "👨‍👩‍👧‍👦".repeat(count);
            // Multibyte text hits the common byte bound before the grapheme bound;
            // an individual provider fragment above the acquisition bound refuses.
            assert_eq!(row.offer(2, &input), Err(1));
        }
        let mut row = SemanticText::new(1).unwrap();
        let input = format!("{} token=syntheticSecret123", "a".repeat(MAX_GRAPHEMES - 8));
        assert_eq!(row.offer(2, &input).unwrap(), Decision::BudgetFull);
        assert_eq!(row.finish().unwrap(), input);
        assert_eq!(row.offer(2, "later"), Err(1));
        let mut exact = SemanticText::new(2).unwrap();
        assert_eq!(
            exact.offer(1, &"é".repeat(MAX_GRAPHEMES)).unwrap(),
            Decision::BudgetFull
        );
    }
    #[test]
    fn complete_last_fragment_protects_a_secret_crossing_the_presentation_cut() {
        let input = format!(
            "{} {}{}",
            "x".repeat(MAX_GRAPHEMES - 6),
            "AKIA",
            "A".repeat(16)
        );
        let mut row = SemanticText::new(1).unwrap();
        assert_eq!(row.offer(2, &input).unwrap(), Decision::BudgetFull);
        let call = |text: &str| -> String {
            let request =
                serde_json::json!({"blocks":[{"kind":"row","text":text}],"caret":["","",""]});
            let reply: serde_json::Value = serde_json::from_slice(
                &crate::context::process(&serde_json::to_vec(&request).unwrap()).unwrap(),
            )
            .unwrap();
            reply["blocks"][0]["text"].as_str().unwrap().to_owned()
        };
        let cut = input.grapheme_indices(true).nth(MAX_GRAPHEMES).unwrap().0;
        // This is the concrete regression a pre-redaction prefix would cause.
        assert!(call(&input[..cut]).contains("AKIA"));
        let redacted = call(row.finish().unwrap());
        let presented: String = redacted.graphemes(true).take(MAX_GRAPHEMES).collect();
        assert!(!presented.contains("AKIA"));
        assert!(redacted.graphemes(true).count() <= MAX_GRAPHEMES);
    }
    #[test]
    fn joined_cluster_accounting_includes_separators_and_boundary_combining_marks() {
        let mut heading = SemanticText::new(2).unwrap();
        heading.offer(1, "").unwrap();
        heading.offer(2, &"x".repeat(MAX_GRAPHEMES - 2)).unwrap();
        // The combining mark joins the space into one cluster, then y reaches
        // the exact shared limit. Counting fragments independently gets this wrong.
        assert_eq!(heading.offer(2, "\u{301}y").unwrap(), Decision::BudgetFull);
        assert_eq!(
            heading.graphemes,
            heading.finish().unwrap().graphemes(true).count()
        );
        let mut prepend = SemanticText::new(1).unwrap();
        prepend.offer(2, "a\u{600}").unwrap();
        prepend.offer(2, "b").unwrap();
        prepend.offer(3, "").unwrap();
        assert_eq!(
            prepend.graphemes,
            prepend.finish().unwrap().graphemes(true).count()
        );
    }
    #[test]
    fn malformed_protocol_cannot_become_an_empty_success() {
        assert!(SemanticText::new(0).is_err());
        let mut row = SemanticText::new(1).unwrap();
        assert_eq!(row.offer(1, "premature fallback"), Err(1));
        assert_eq!(row.offer(3, "nonempty terminator"), Err(1));
        assert_eq!(row.finish(), Err(1));
    }
}
