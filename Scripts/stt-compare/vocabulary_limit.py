#!/usr/bin/env python3
"""Measure how many vocabulary terms a speech-to-text model takes through OpenRouter.

Sends one recording several times, each with a phrase list of a different length, in the request
shape the TabMail backend sends (`provider.options.azure.phraseList.phrases` for MAI-Transcribe,
`provider.options.assemblyai.keyterms_prompt` for AssemblyAI), and reports for each length whether
the provider took it (HTTP status, its error text when refused), the time it took and the
transcript. The terms are made-up names, distinct case-insensitively, each a valid dictionary word.

Needs OPENROUTER_API_KEY, read as compare.py reads it (environment, or --env-file, with --sudo for a
root-owned file). The key is never printed or written.

    python3 Scripts/stt-compare/vocabulary_limit.py --sudo --env-file path/to/secrets.env
    python3 Scripts/stt-compare/vocabulary_limit.py --counts 50 51 100 200 --recording 05-jargon
    python3 Scripts/stt-compare/vocabulary_limit.py --model assemblyai/universal-3-5-pro

With --canary, the list's LAST term is a spelling of a word in the recording the model would not
write unprompted, so a transcript holding it shows the end of a long list still reaches the model
(a list cut short in silence would not). A well-known word makes a poor canary (the model keeps its
own spelling); --speak records a sentence with macOS `say` instead, so the canary can be a made-up
name only the list spells right. Check that the 0-term row misspells it.

--bisect LO HI finds the largest list taken between LO (taken) and HI (refused), after a 0- and a
10-term row. --bisect-heard LO HI finds the largest list whose canary is still heard, between LO
(heard) and HI (taken but not heard); each length is sent --repeat times and every try must agree,
else the run stops there (the edge is not sharp). Writes results/vocabulary-<timestamp>.md and .json.

    python3 Scripts/stt-compare/vocabulary_limit.py --sudo --env-file path/to/secrets.env \
        --bisect 200 500 --speak "Please send the contract to Xyvora Kaelthorne by Friday." --canary Xyvora
    python3 Scripts/stt-compare/vocabulary_limit.py --sudo --env-file path/to/secrets.env --repeat 3 \
        --bisect-heard 120 130 --speak "Please send the contract to Xyvora Kaelthorne by Friday." --canary Xyvora
"""

import argparse
import base64
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

from compare import ENDPOINT, HERE, TIMEOUT_SECONDS, key_from_env_file

DEFAULT_MODEL = "microsoft/mai-transcribe-2"
DEFAULT_COUNTS = [0, 10, 50, 51, 100, 200, 500, 1000, 2000]
# How each model takes its terms, as the backend's `vocabulary.formats` sends them.
FORMATS = {
    "microsoft/mai-transcribe-2": lambda terms: {"azure": {"phraseList": {"phrases": terms}}},
    "microsoft/mai-transcribe-1.5": lambda terms: {"azure": {"phraseList": {"phrases": terms}}},
    "assemblyai/universal-3-5-pro": lambda terms: {"assemblyai": {"keyterms_prompt": terms}},
}
RATE_LIMIT_RETRIES = 5
RATE_LIMIT_WAIT_SECONDS = 3
# Common one-token English words, and Hangul syllables for made-up Korean names: lists of these
# reach a token limit at a different count than made-up Latin names do.
WORDS = """apple river table garden window pencil mountain bottle candle doctor engine forest guitar hammer
island jacket kitchen ladder market needle orange pocket rabbit saddle teacher tunnel valley wagon yellow
anchor basket butter camera carpet cattle cheese circle cotton dinner dragon farmer finger flower friend
hollow honey hunter jungle kettle lemon letter lizard meadow mirror monkey mother nickel office parcel
pepper pillow planet puppet rocket silver singer sister spider summer sunset tiger timber tomato tower
violin wallet winter wizard zipper badge beach blade bread brick brush cable chain chair chalk cloud coach
coast crane crown dance drill eagle field flame frost glass glove grape grass heart horse house juice knife
lamp light linen money motor music night ocean paint paper party piano pilot plate queen radio robot salad
scarf shark sheep shirt shoe smoke snake sound spoon stamp steam stone storm sugar sword thumb toast train
truck uncle voice watch whale wheat wheel woman world beard bench berry blanket bridge castle cherry clock
cookie cousin desert dollar donkey feather fence fiddle folder fridge goat harbor helmet iron jelly kitten
lantern magnet marble medal mitten muffin noodle oyster paddle peanut pebble pigeon pirate pumpkin puzzle
""".split()
HANGUL = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하", "서", "윤"]
SYLLABLES = ["zor", "vek", "qua", "lin", "dra", "mos", "thal", "bri", "ux", "pel", "kor", "ny", "vas", "trel", "ond", "fi"]


def filler_terms(count: int, chars: int = 0, kind: str = "names"):
    """`count` distinct made-up names ("Zorvekqua"), none an English word; with `chars`, each padded
    with more made-up words to exactly that many characters. `kind` "words" gives common English
    words instead (one, then two per term past the list), "hangul" made-up three-syllable Korean names."""
    if kind == "words":
        n = len(WORDS)
        return [WORDS[i % n] if i < n else f"{WORDS[i % n]} {WORDS[(i // n) % n]}" for i in range(count)]
    if kind == "hangul":
        n = len(HANGUL)
        return [HANGUL[i % n] + HANGUL[(i // n) % n] + HANGUL[(i // (n * n)) % n] for i in range(count)]
    terms = []
    n = len(SYLLABLES)
    for index in range(count):
        a, b, c = index % n, (index // n) % n, (index // (n * n)) % n
        terms.append((SYLLABLES[a] + SYLLABLES[b] + SYLLABLES[c] + f" {index // (n ** 3)}" * (index >= n ** 3)).capitalize())
    if chars:
        padded = []
        for index, term in enumerate(terms):
            filler = " ".join(SYLLABLES[(index + k) % n] + SYLLABLES[(index * 7 + k) % n] for k in range(chars))
            padded.append((term + " " + filler)[:chars].rstrip().ljust(chars, "x"))
        terms = padded
    return terms


def transcribe(key: str, model: str, wav: pathlib.Path, terms):
    """One request, sent again after a rate limit (HTTP 429) up to RATE_LIMIT_RETRIES times."""
    for _ in range(RATE_LIMIT_RETRIES):
        result = transcribe_once(key, model, wav, terms)
        if result["status"] != 429:
            return result
        time.sleep(RATE_LIMIT_WAIT_SECONDS)
    return result


def transcribe_once(key: str, model: str, wav: pathlib.Path, terms):
    body = {
        "model": model,
        "input_audio": {"data": base64.b64encode(wav.read_bytes()).decode(), "format": "wav"},
        "temperature": 0,
    }
    if terms:
        body["provider"] = {"options": FORMATS[model](terms)}
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.load(response)
        return {"status": response.status, "text": payload.get("text", ""), "seconds": time.monotonic() - started,
                "cost": (payload.get("usage") or {}).get("cost") or 0, "error": None}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        return {"status": error.code, "text": "", "seconds": time.monotonic() - started, "cost": 0, "error": detail}
    except Exception as error:  # network errors, timeouts
        return {"status": None, "text": "", "seconds": time.monotonic() - started, "cost": 0,
                "error": f"{type(error).__name__}: {error}"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(FORMATS))
    parser.add_argument("--counts", nargs="+", type=int, default=DEFAULT_COUNTS, help="list lengths to try, in order")
    parser.add_argument("--recording", default="05-jargon", help="a recordings/<id>.wav (default 05-jargon)")
    parser.add_argument("--speak", help="record this sentence with macOS `say` and use it instead of --recording")
    parser.add_argument("--bisect", nargs=2, type=int, metavar=("LO", "HI"),
                        help="find the largest list taken between LO and HI instead of trying --counts")
    parser.add_argument("--bisect-heard", nargs=2, type=int, metavar=("LO", "HI"),
                        help="find the largest list whose canary is heard between LO and HI, each length --repeat times")
    parser.add_argument("--canary", default="Kubernetties",
                        help="the list's last term: a spelling of a word in the recording (default Kubernetties, "
                             "for 05-jargon's \"Kubernetes\"); empty for none")
    parser.add_argument("--canary-position", choices=["first", "last"], default="last",
                        help="where the canary goes in the list (default last)")
    parser.add_argument("--term-chars", type=int, default=0,
                        help="pad every filler term to this many characters (default: names of 9-12)")
    parser.add_argument("--filler", choices=["names", "words", "hangul"], default="names",
                        help="filler terms: made-up Latin names (default), common English words, or made-up Korean names")
    parser.add_argument("--repeat", type=int, default=1, help="requests per list length (default 1)")
    parser.add_argument("--env-file", type=pathlib.Path, default=HERE / ".env",
                        help="file with an OPENROUTER_API_KEY=... line (default: .env next to this script)")
    parser.add_argument("--sudo", action="store_true", help="read --env-file through sudo (for a root-owned secrets file)")
    args = parser.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY") or key_from_env_file(args.env_file.expanduser(), args.sudo)
    if not key:
        sys.exit(f"No OPENROUTER_API_KEY in the environment or in {args.env_file}.")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = HERE / "results" / f"vocabulary-{stamp}"
    out.parent.mkdir(exist_ok=True)
    if args.speak:
        wav = out.with_suffix(".wav")
        subprocess.run(["say", "-o", str(wav), "--data-format=LEI16@16000", args.speak], check=True)
        source = f"said: {args.speak}"
    else:
        wav = HERE / "recordings" / f"{args.recording}.wav"
        source = f"recording {args.recording}"
    if not wav.is_file():
        sys.exit(f"No recording {wav}.")

    rows = []

    def attempt(count: int):
        terms = filler_terms(count, args.term_chars, args.filler)
        if args.canary and count > 0:
            terms[0 if args.canary_position == "first" else -1] = args.canary
        result = transcribe(key, args.model, wav, terms)
        canary_heard = bool(args.canary) and count > 0 and args.canary.lower() in result["text"].lower()
        rows.append({"count": count, "canary_heard": canary_heard, **result})
        outcome = f"HTTP {result['status']}" + (f" {result['error'][:160]}" if result["error"] else "")
        print(f"  {count:5d} terms: {outcome} · {result['seconds']:.1f}s" + (" · canary heard" if canary_heard else ""))
        if result["status"] not in (200, 400):
            sys.exit(f"HTTP {result['status']} is neither taken nor refused: stopping.")
        return rows[-1]

    def heard(count: int):
        """True when every try heard the canary, False when none did, None when they disagree."""
        tries = [attempt(count) for _ in range(args.repeat)]
        if any(row["status"] != 200 for row in tries):
            sys.exit(f"{count} terms refused: --bisect-heard needs lengths the provider takes.")
        hits = sum(row["canary_heard"] for row in tries)
        return True if hits == len(tries) else False if hits == 0 else None

    if args.bisect_heard:
        if not args.canary:
            sys.exit("--bisect-heard needs a --canary.")
        attempt(0)
        low, high = args.bisect_heard
        verdicts = {low: heard(low), high: heard(high)}
        if verdicts[low] is not True or verdicts[high] is not False:
            print(f"Need the canary heard every time at {low} and never at {high}: give other bounds.")
        else:
            while high - low > 1:
                middle = (low + high) // 2
                verdicts[middle] = heard(middle)
                if verdicts[middle] is None:
                    print(f"{middle} terms: the canary was heard in some tries only; stopping (no sharp edge).")
                    break
                if verdicts[middle]:
                    low = middle
                else:
                    high = middle
            else:
                print(f"Largest list heard: {low} terms ({high} ignored), {args.repeat} tries each.")
    elif args.bisect:
        for count in (0, 10):
            attempt(count)
        low, high = args.bisect
        if attempt(low)["status"] != 200:
            sys.exit(f"{low} terms already refused: give a smaller LO.")
        if attempt(high)["status"] == 200:
            sys.exit(f"{high} terms taken: give a larger HI.")
        while high - low > 1:
            middle = (low + high) // 2
            if attempt(middle)["status"] == 200:
                low = middle
            else:
                high = middle
        print(f"Largest list taken: {low} terms ({high} refused).")
    else:
        for count in args.counts:
            for _ in range(args.repeat):
                attempt(count)

    rows.sort(key=lambda row: row["count"])
    canary = f"{args.canary} ({args.canary_position})" if args.canary else "none"
    canary += f", filler terms of {args.term_chars} characters" if args.term_chars else ""
    canary += f", {args.filler} filler" if args.filler != "names" else ""
    lines = [f"# Vocabulary limit: {args.model}, {source}, canary {canary}", "",
             "| Terms | HTTP | Seconds | Canary heard | Error |", "|---|---|---|---|---|"]
    for row in rows:
        error = (row["error"] or "").replace("|", "\\|").replace("\n", " ")[:200]
        lines.append(f"| {row['count']} | {row['status']} | {row['seconds']:.1f} | {'yes' if row['canary_heard'] else ''} | {error} |")
    lines += ["", "## Transcripts", ""] + [f"- **{row['count']}**: {row['text']}" for row in rows]
    out.with_suffix(".md").write_text("\n".join(lines) + "\n")
    out.with_suffix(".json").write_text(json.dumps({"model": args.model, "source": source,
                                                    "canary": args.canary, "rows": rows}, indent=2) + "\n")
    print(f"Wrote {out}.md and .json")


if __name__ == "__main__":
    main()
