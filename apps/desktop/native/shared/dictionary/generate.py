# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Builds the word list the screen terms are judged by (ADR-DESK-038, amended 2026-11-05 and
2026-11-06).

`words.txt` holds the words of 41 language lists merged into one, each word with the most often any
of them sees it. Each list is one language's words seen at least `MIN_ZIPF` often, with how often:
Zipf (log10 of the frequency per billion words) in tenths. The words and their counts come from
FrequencyWords (Hermit Dave's word counts of OpenSubtitles 2018, CC BY-SA 4.0), one or more of its
lists a language (`SOURCES`); Korean's words keep their particles, as Korean is written. A list keeps
only words written in its language's scripts (those of CLDR's main exemplar letters), so no list
holds a word of another script ("the" in Russian's, homoglyph junk). Japanese has no list:
FrequencyWords' Japanese list holds word stems without their kana (no "その"), so it would make
every Japanese word a term; with none, a word in kana is no term, and one in Han alone is judged by
Chinese's list.

A word is stored in the form wordfreq's `preprocess_text` (and, for Chinese, `simplify_chinese`)
gives it (its code; of its data only the letter tables, not its word frequencies), so a word asked about is put in that form
before it is looked up: "Већ" is listed as "već", "電腦" as "电脑", "شكراً" as "شكرا". Counts of words
that share a form are added up. `languages.json` names, for each list, its writings (each the ISO
15924 scripts one word may mix; Serbian is written in Latin or in Cyrillic, never both in a word) and those steps, taken from wordfreq's language info: the normal
form (NFC or NFKC), the table each letter is replaced through (`letters`: Serbian's Cyrillic to
Latin, from wordfreq's code, and Chinese's Traditional to Simplified, wordfreq's table made with
OpenCC), whether marks are removed (abjad vowel points and the Arabic tatweel), Turkish's dotted and
dotless i, and whether s and t take a comma or a cedilla below. Korean's list is in NFC lowercase with
no other step. A word is looked up in each form the lists written in its script give it.

Run with Python 3.12+ and the pinned packages in `requirements.txt`, from this folder:

    python3 -m venv /tmp/word-lists && /tmp/word-lists/bin/pip install -r requirements.txt
    /tmp/word-lists/bin/python generate.py

It downloads CLDR's JSON data at `CLDR_VERSION` and FrequencyWords at `FREQUENCY_WORDS` from GitHub,
and writes `words.txt` and `languages.json`; the output is the same on every run.
"""

import gzip
import json
import math
import unicodedata
import urllib.request
from pathlib import Path

import msgpack
import regex
import wordfreq
from wordfreq.language_info import get_language_info
from wordfreq.preprocess import preprocess_text
from wordfreq.transliterate import SR_LATN_TABLE

CLDR_VERSION = "48.0.0"
CLDR = f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_VERSION}/cldr-json"
FREQUENCY_WORDS = "525f9b560de45753a5ea01069454e72e9aa541c6"
FREQUENCY_LIST = f"https://raw.githubusercontent.com/hermitdave/FrequencyWords/{FREQUENCY_WORDS}/content/2018/{{code}}/{{code}}_full.txt"
MIN_ZIPF = 2.5
# Inside a word: apostrophes ("don't"), Catalan's middle dot ("col·lecció"), and the zero-width
# non-joiner and joiner Persian, Hindi and Bengali spell words with ("می‌شود").
INNER = "'’·\u200c\u200d"
HERE = Path(__file__).resolve().parent

# The lists, each with the CLDR locales whose letters name its scripts ("sh" is wordfreq's
# Serbo-Croatian: written in Latin and Cyrillic letters, listed in Latin ones).
LISTS = {
    "ar": ["ar"], "bg": ["bg"], "bn": ["bn"], "ca": ["ca"], "cs": ["cs"], "da": ["da"], "de": ["de"],
    "el": ["el"], "en": ["en"], "es": ["es"], "fa": ["fa"], "fi": ["fi"], "fil": ["fil"], "fr": ["fr"],
    "he": ["he"], "hi": ["hi"], "hu": ["hu"], "id": ["id"], "is": ["is"], "it": ["it"],
    "ko": ["ko"], "lt": ["lt"], "lv": ["lv"], "mk": ["mk"], "ms": ["ms"], "nb": ["nb"], "nl": ["nl"],
    "pl": ["pl"], "pt": ["pt"], "ro": ["ro"], "ru": ["ru"], "sh": ["hr", "sr"], "sk": ["sk"], "sl": ["sl"],
    "sv": ["sv"], "ta": ["ta"], "tr": ["tr"], "uk": ["uk"], "ur": ["ur"], "vi": ["vi"], "zh": ["zh"],
}
# FrequencyWords' lists each list counts, where its code differs from the list's or several make one:
# Filipino is its Tagalog, Norwegian Bokmål its Norwegian, Portuguese and Chinese both their
# spellings, Serbo-Croatian its Croatian, Serbian and Bosnian.
SOURCES = {"fil": ["tl"], "nb": ["no"], "pt": ["pt", "pt_br"], "sh": ["hr", "sr", "bs"], "zh": ["zh_cn", "zh_tw"]}
# The scripts a list may be written in (ISO 15924), tried in this order for each letter.
SCRIPTS = ["Latn", "Cyrl", "Grek", "Arab", "Hebr", "Deva", "Beng", "Taml", "Hang", "Hira", "Kana", "Hani"]


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def script(char: str) -> str | None:
    """The ISO 15924 script of a letter among `SCRIPTS`, or None (Common, Inherited, another)."""
    for name in SCRIPTS:
        if regex.match(rf"\p{{Script={name}}}", char):
            return name
    return None


def unicode_set(text: str) -> set[str]:
    """The characters of a CLDR UnicodeSet such as "[aä b c {ch} а-е \\-]"."""
    chars: set[str] = set()
    body = text.strip()[1:-1]
    index, previous = 0, None
    while index < len(body):
        char = body[index]
        if char == " ":
            index += 1
        elif char == "{":
            end = body.index("}", index)
            chars.update(body[index + 1:end])
            previous, index = None, end + 1
        elif char == "-" and previous is not None and index + 1 < len(body):
            chars.update(chr(code) for code in range(ord(previous) + 1, ord(body[index + 1]) + 1))
            previous, index = None, index + 2
        else:
            if char == "\\":
                index += 1
                char = body[index]
            chars.add(char)
            previous, index = char, index + 1
    return chars


def writings_of(locales: list[str]) -> list[list[str]]:
    """Each locale's scripts: the scripts one word may mix, one locale a way
    the language is written (Serbo-Croatian's Latin, Serbian's Cyrillic)."""
    writings: list[list[str]] = []
    for locale in locales:
        characters = json.loads(fetch(f"{CLDR}/cldr-misc-full/main/{locale}/characters.json"))["main"][locale]["characters"]
        writings.append(sorted(set(filter(None, map(script, unicode_set(characters["exemplarCharacters"]))))))
    return sorted(writings)


def form(language: str) -> dict:
    """How a word is put in the form `language`'s list has it in, as wordfreq does (see the top)."""
    if language == "ko":
        return {"normal": "NFC", "letters": None, "marks": False, "dotless_i": False, "under": None}
    info = get_language_info(language)
    return {
        "normal": info["normal_form"],
        "letters": info["transliteration"] or info["lookup_transliteration"],
        "marks": info["remove_marks"],
        "dotless_i": info["dotless_i"],
        "under": info["diacritics_under"],
    }


def letter_tables() -> dict[str, dict[str, str]]:
    """wordfreq's tables of what each letter is replaced by: Serbian's Cyrillic to Latin, and
    Chinese's Traditional to Simplified (the data its `simplify_chinese` uses)."""
    with gzip.open(Path(wordfreq.__file__).parent / "data" / "_chinese_mapping.msgpack.gz", "rb") as file:
        simplified = msgpack.load(file, raw=False, strict_map_key=False)
    return {
        "sr-Latn": {chr(code): latin for code, latin in SR_LATN_TABLE.items()},
        "zh-Hans": {chr(code): simple for code, simple in simplified.items()},
    }


def listed(word: str, language: str) -> str:
    """`word` in the form its list holds it, the one a word asked about is put in (`languages.json`):
    wordfreq's own normalisation for the language, Chinese simplified; Korean's, NFC lowercase."""
    if language == "ko":
        return unicodedata.normalize("NFC", word).lower()
    form = preprocess_text(word, language)
    # wordfreq's `simplify_chinese` (its module needs jieba, which nothing here uses).
    return form.translate(SIMPLIFIED).casefold() if language == "zh" else form


SIMPLIFIED = str.maketrans(letter_tables()["zh-Hans"])


def frequencies(language: str) -> dict[str, float]:
    """How often each word of `language` is seen in FrequencyWords' counts (its sources together), each
    word in its list's form."""
    counts: dict[str, int] = {}
    for code in SOURCES.get(language, [language]):
        for line in fetch(FREQUENCY_LIST.format(code=code)).decode("utf-8").splitlines():
            word, _, count = line.rpartition(" ")
            if word and count.isdigit():
                form = listed(word, language)
                counts[form] = counts.get(form, 0) + int(count)
    total = sum(counts.values())
    return {word: count / total for word, count in counts.items()}


def build(language: str, scripts: list[str]) -> dict[str, int]:
    kept: dict[str, int] = {}
    for word, frequency in frequencies(language).items():
        tenths = round((math.log10(frequency) + 9) * 10)
        if tenths < MIN_ZIPF * 10:
            continue
        word = unicodedata.normalize("NFC", word).replace("’", "'")
        written = [script(char) for char in word if unicodedata.category(char)[0] in "LM"]
        if not written or any(name not in scripts for name in written if name is not None) or all(name is None for name in written):
            continue
        # Letters and marks only, besides the apostrophes inside a word ("don't") and Catalan's
        # middle dot ("col·lecció"); no digit, no punctuation.
        if any(unicodedata.category(char)[0] not in "LM" and char not in INNER for char in word) or word[0] in INNER or word[-1] in INNER:
            continue
        kept[word] = max(kept.get(word, 0), tenths)
    return kept


def main() -> None:
    merged: dict[str, int] = {}
    described: dict[str, dict] = {}
    for language, locales in LISTS.items():
        writings = writings_of(locales)
        scripts = sorted({name for writing in writings for name in writing})
        kept = build(language, scripts)
        for word, tenths in kept.items():
            merged[word] = max(merged.get(word, 0), tenths)
        described[language] = {"writings": writings, **form(language)}
        print(f"{language} {' '.join('+'.join(writing) for writing in writings)}: {len(kept)} words")
    lines = sorted(merged.items(), key=lambda item: item[0].encode())
    (HERE / "words.txt").write_text("".join(f"{word}\t{tenths}\n" for word, tenths in lines), encoding="utf-8")
    print(f"all: {len(lines)} words")
    (HERE / "languages.json").write_text(json.dumps({"lists": described, "letters": letter_tables()}, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
