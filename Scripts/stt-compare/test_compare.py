#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Checks compare.py's scoring: python3 Scripts/stt-compare/test_compare.py"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import compare  # noqa: E402


class ScoringTests(unittest.TestCase):
    def errors(self, reference, hypothesis):
        return compare.word_errors(reference, hypothesis)[0]

    def test_number_formatting_is_not_an_error(self):
        cases = [
            ("The invoice total is four thousand two hundred eighty dollars and fifty cents, due on "
             "March fourteenth, reference number seven three nine two.",
             "The invoice total is $4,280.50, due on March 14th, reference number 7392."),
            ("due on March fourteenth", "due on March 14"),
            ("before nine", "before 9."),
            ("my three o'clock", "my 3 o'clock"),
            ("the third quarter", "the 3rd quarter"),
            ("Wednesday at ten a.m.", "Wednesday at 10 AM"),
            ("Send the draft to support at example dot com", "Send the draft to support@example.com"),
            ("Sounds good, thanks!", "Sounds good. Thanks."),
            ("I'll review them", "I’ll review them"),
        ]
        for reference, hypothesis in cases:
            with self.subTest(hypothesis=hypothesis):
                self.assertEqual(self.errors(reference, hypothesis), 0)

    def test_wrong_words_still_count(self):
        self.assertEqual(self.errors("check the IMAP sync logs", "check the IAM logs"), 2)
        self.assertEqual(self.errors("before nine", "before 8"), 1)
        self.assertEqual(self.errors("reference number seven three nine two", "reference number 7393"), 1)

    def test_non_english_reference_keeps_its_own_words(self):
        self.assertEqual(self.errors("내일 오후 세 시", "내일 오후 세 시"), 0)
        self.assertEqual(self.errors("내일 오후 세 시", "내일 오후 3 시"), 1)

    def test_summary_is_corpus_wer_with_cost_per_hour(self):
        results = [
            {"passage": "a", "error": None, "word_errors": 1, "reference_words": 10, "seconds": 1.0, "cost": 0.001},
            {"passage": "b", "error": None, "word_errors": 0, "reference_words": 30, "seconds": 3.0, "cost": 0.002},
            {"passage": "c", "error": "timeout", "word_errors": None, "reference_words": None, "seconds": 60.0, "cost": 0},
        ]
        summary = compare.summarize(results, {"a": 6.0, "b": 12.0, "c": 5.0}.__getitem__)
        self.assertAlmostEqual(summary["wer"], 1 / 40)
        self.assertEqual(summary["median_seconds"], 2.0)
        self.assertAlmostEqual(summary["cost_per_hour"], 0.003 / 18 * 3600)
        self.assertEqual(summary["errors"], 1)


if __name__ == "__main__":
    unittest.main()
