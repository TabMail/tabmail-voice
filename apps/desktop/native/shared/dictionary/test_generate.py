# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Tests of `generate.py`, offline: every download is answered from the fixtures below. Run with the
pinned packages (README), from this folder:

    /tmp/word-lists/bin/python -m unittest test_generate
"""

import json
import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest import mock

import generate

# One CLDR main exemplar set each locale the fixture lists name.
CHARACTERS = {
    "pt": "[a á â ã b c ç d e é ê f g h i í j k l m n o ó ô õ p q r s t u ú v w x y z]",
    "ko": "[가-힣]",
    "zh": "[一-龥]",
}


def counts(*pairs: tuple[str, int]) -> str:
    """A FrequencyWords list: one `word count` a line."""
    return "".join(f"{word} {count}\n" for word, count in pairs)


class Downloads:
    """Answers `generate.fetch` for the lists and CLDR files the test gives, and records each URL."""

    def __init__(self, lists: dict[str, str]):
        self.lists = lists
        self.asked: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.asked.append(url)
        for code, body in self.lists.items():
            if url == generate.FREQUENCY_LIST.format(code=code):
                return body.encode()
        for locale, characters in CHARACTERS.items():
            if url == f"{generate.CLDR}/cldr-misc-full/main/{locale}/characters.json":
                return json.dumps({"main": {locale: {"characters": {"exemplarCharacters": characters}}}}).encode()
        raise AssertionError(f"unexpected download {url}")


class Frequencies(unittest.TestCase):
    def test_a_language_counts_each_of_its_sources_together(self):
        downloads = Downloads({"pt": counts(("olá", 1), ("casa", 3)), "pt_br": counts(("olá", 3), ("você", 3))})
        with mock.patch.object(generate, "fetch", downloads):
            seen = generate.frequencies("pt")
        self.assertEqual(seen, {"olá": 0.4, "casa": 0.3, "você": 0.3})
        self.assertEqual(downloads.asked, [generate.FREQUENCY_LIST.format(code=code) for code in ["pt", "pt_br"]])

    def test_counts_are_added_up_after_each_word_is_put_in_its_lists_form(self):
        # "Olá" and "olá" are one word once case-folded; Korean's decomposed and composed "가" one once
        # in NFC; Chinese's Traditional "電腦" and Simplified "电脑" one once simplified.
        cases = {
            "pt": ({"pt": counts(("Olá", 2), ("olá", 6), ("casa", 2)), "pt_br": ""}, {"olá": 0.8, "casa": 0.2}),
            "ko": ({"ko": counts((unicodedata.normalize("NFD", "가"), 1), ("가", 1), ("나", 2))}, {"가": 0.5, "나": 0.5}),
            "zh": ({"zh_cn": counts(("电脑", 1), ("你好", 2)), "zh_tw": counts(("電腦", 1))}, {"电脑": 0.5, "你好": 0.5}),
        }
        for language, (lists, expected) in cases.items():
            with self.subTest(language), mock.patch.object(generate, "fetch", Downloads(lists)):
                self.assertEqual(generate.frequencies(language), expected)

    def test_lines_without_a_count_are_skipped(self):
        with mock.patch.object(generate, "fetch", Downloads({"pt": "casa 3\nsem\ncasa x\nmais 1\n", "pt_br": ""})):
            self.assertEqual(generate.frequencies("pt"), {"casa": 0.75, "mais": 0.25})


class Lists(unittest.TestCase):
    def test_each_list_counts_its_frequencywords_lists(self):
        self.assertEqual(generate.SOURCES, {"fil": ["tl"], "nb": ["no"], "pt": ["pt", "pt_br"], "sh": ["hr", "sr", "bs"], "zh": ["zh_cn", "zh_tw"]})
        self.assertEqual(len(generate.LISTS), 41)
        for language in generate.SOURCES:
            self.assertIn(language, generate.LISTS)

    def test_japanese_has_no_list(self):
        # FrequencyWords' Japanese list holds stems without their kana; with it every Japanese word
        # would look rare.
        self.assertNotIn("ja", generate.LISTS)
        self.assertNotIn("ja", generate.SOURCES)

    def test_a_list_keeps_words_seen_often_enough_in_its_scripts_as_zipf_tenths(self):
        # Of 10,000,000 counted words, "casa" is seen 5,000,000 times (Zipf 8.7), "você" 4,999,994
        # (8.7), "rara" 3 (2.5, the floor: kept), "raríssima" 2 (2.3: dropped), "дом" 1 (Cyrillic, not
        # Portuguese's script: dropped).
        seen = counts(("casa", 5_000_000), ("você", 4_999_994), ("rara", 3), ("raríssima", 2), ("дом", 1))
        with mock.patch.object(generate, "fetch", Downloads({"pt": seen, "pt_br": ""})):
            kept = generate.build("pt", ["Latn"])
        self.assertEqual(kept, {"casa": 87, "você": 87, "rara": 25})

    def test_a_word_is_letters_and_marks_with_its_joiners_inside(self):
        seen = counts(("casa", 4), ("d'água", 1), ("abc1", 1), ("'casa", 1), ("casa'", 1), ("a-b", 1), ("casa’s", 1))
        with mock.patch.object(generate, "fetch", Downloads({"pt": seen, "pt_br": ""})):
            kept = generate.build("pt", ["Latn"])
        # The curly apostrophe is stored straight.
        self.assertEqual(sorted(kept), ["casa", "casa's", "d'água"])


class Main(unittest.TestCase):
    def test_writes_the_merged_list_and_the_catalog(self):
        lists = {
            "pt": counts(("casa", 6), ("mar", 3), ("rara", 1)),
            "pt_br": counts(("mar", 1)),
            "ko": counts(("가", 9), ("mar", 1)),
        }
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(generate, "fetch", Downloads(lists)), \
                mock.patch.object(generate, "LISTS", {"pt": ["pt"], "ko": ["ko"]}), \
                mock.patch.object(generate, "HERE", Path(folder)), \
                mock.patch("builtins.print"):
            generate.main()
            words = (Path(folder) / "words.txt").read_text(encoding="utf-8")
            catalog = json.loads((Path(folder) / "languages.json").read_text(encoding="utf-8"))
        # Sorted by UTF-8 bytes; of Portuguese's 11 words "casa" is 6 (Zipf 8.7), "mar" 4 (8.6, its two
        # sources added up) and "rara" 1 (8.0); "mar" is Latin, so Korean's list drops it; "가" is 9 of 10.
        self.assertEqual(words, "casa\t87\nmar\t86\nrara\t80\n가\t90\n")
        self.assertEqual(sorted(catalog["lists"]), ["ko", "pt"])
        self.assertEqual(catalog["lists"]["pt"]["writings"], [["Latn"]])
        self.assertEqual(catalog["lists"]["ko"], {"writings": [["Hang"]], "normal": "NFC", "letters": None, "marks": False, "dotless_i": False, "under": None})
        self.assertEqual(sorted(catalog["letters"]), ["sr-Latn", "zh-Hans"])


if __name__ == "__main__":
    unittest.main()
