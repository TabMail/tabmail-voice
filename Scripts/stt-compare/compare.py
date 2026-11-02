#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Transcribe every recording with several OpenRouter speech-to-text models and score them.

Needs OPENROUTER_API_KEY, either in the environment or as a KEY=value line in an env file
(--env-file, default Scripts/stt-compare/.env, gitignored; add --sudo when that file is
root-owned). The key is never printed or written.
Sends the same request shape the TabMail backend sends.

    python3 Scripts/stt-compare/compare.py
    python3 Scripts/stt-compare/compare.py --env-file path/to/secrets.env
    python3 Scripts/stt-compare/compare.py --sudo --env-file path/to/root-owned-secrets.env
    python3 Scripts/stt-compare/compare.py --language en
    python3 Scripts/stt-compare/compare.py --models openai/whisper-large-v3-turbo deepgram/nova-3
    python3 Scripts/stt-compare/compare.py --models deepgram/nova-3 --voice Yuna --speak "내일 오후 세 시에 회의 일정을 잡아 주세요."

--speak records one sentence with macOS `say` (--voice picks the voice, e.g. Yuna for Korean) and
scores it instead of recordings/; leave out --language to see whether a model detects the language.

    python3 Scripts/stt-compare/compare.py --rescore results/20260924-220953.json results/20261101-222917.json

--rescore sends nothing: it re-scores saved runs with the current scoring and passages.txt and
writes one combined table (results/rescore-<timestamp>.md), so runs from different days compare.

Writes results/<timestamp>.md (summary table + every transcript) and .json.
WER = word errors over all reference words (corpus WER) against passages.txt, after lower-casing,
stripping punctuation and, for English, writing numbers out the way passages.txt reads them
("$4,280.50" = "four thousand two hundred eighty dollars and fifty cents", "9" = "nine",
"March 14th" = "March fourteenth", "a.m." = "am", "support@example.com" = "support at example
dot com"), so a model isn't marked down for formatting; read the transcripts for punctuation,
casing and number style.

Each recording is boosted the way the apps boost a dictation before upload (ADR-DESK-040,
ADR-IOS-085): one gain for the whole clip so its loudest sample sits at −3 dBFS, at most +30 dB,
never quieter. --raw sends the recordings as captured instead. Runs before 2026-11-01 were raw.
$/hour = the reported cost over the seconds of audio sent, so it
includes any per-request minimum billing on short dictation-length clips.
"""
import argparse
import array
import base64
import concurrent.futures
import datetime
import io
import json
import math
import os
import pathlib
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave

HERE = pathlib.Path(__file__).resolve().parent
ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
# Speech-to-text models whose every OpenRouter endpoint is on the Zero Data Retention list
# (checked 2026-09-24 via /api/v1/endpoints/zdr; re-checked live on every run, see the ZDR
# column). Left out: models with no ZDR endpoint (OpenAI first-party gpt-*/whisper-1, Google
# AI Studio gemini-3.5-transcribe, Meta, Alibaba qwen3-asr-flash, xAI grok-stt) and Azure
# mai-transcribe-1.5 (superseded by mai-transcribe-2; add it with --models if you want it).
# The Cost column is OpenRouter's reported usage.cost, so a listed price with no clear unit
# (the Azure mai-transcribe models) is measured rather than assumed.
DEFAULT_MODELS = [
    "openai/whisper-large-v3-turbo",
    "openai/whisper-large-v3",
    "nvidia/parakeet-tdt-0.6b-v3",
    "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    "qwen/qwen3-asr-1.7b",
    "qwen/qwen3-asr-0.6b",
    "mistralai/voxtral-mini-transcribe",
    "mistralai/voxtral-mini-3b-2507",
    "mistralai/voxtral-small-24b-2507-stt",
    "mistralai/voxtral-small-transcribe-3-0",
    "assemblyai/universal-3-5-pro",
    "deepgram/nova-3",
    "fish-audio/transcribe-1",
    "fish-audio/transcribe-1-pro",
    "google/chirp-3",
    "microsoft/mai-transcribe-2",
]
ZDR_LIST = "https://openrouter.ai/api/v1/endpoints/zdr"
MODEL_ENDPOINTS = "https://openrouter.ai/api/v1/models/{model}/endpoints"
TIMEOUT_SECONDS = 60
# The apps' upload boost: apps/desktop/src/core/config.ts normalizedPeakDecibels and
# maxNormalizationGainDecibels (the iOS app uses the same two values). Keep them equal.
NORMALIZED_PEAK_DECIBELS = -3
MAX_NORMALIZATION_GAIN_DECIBELS = 30
PARALLEL_REQUESTS = 6


def references():
    refs = {}
    for line in (HERE / "passages.txt").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            pid, text = (part.strip() for part in line.split("|", 1))
            refs[pid] = text
    return refs


ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen").split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
IRREGULAR_ORDINALS = {"one": "first", "two": "second", "three": "third", "five": "fifth",
                      "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}
MONTHS = "january february march april may june july august september october november december".split()


def cardinal(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000:
        return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + cardinal(n % 100))
    return cardinal(n // 1000) + " thousand" + ("" if n % 1000 == 0 else " " + cardinal(n % 1000))


def ordinal(n: int) -> str:
    spoken = cardinal(n).split()
    last = spoken[-1]
    spoken[-1] = IRREGULAR_ORDINALS.get(last, last[:-1] + "ieth" if last.endswith("y") else last + "th")
    return " ".join(spoken)


def spell_numbers(text: str) -> str:
    """English text with numbers, money, times and email addresses written as passages.txt reads them."""
    text = re.sub(r"([a-z0-9])@([a-z0-9])", r"\1 at \2", text)
    text = re.sub(r"([a-z])\.(com|org|net)\b", r"\1 dot \2", text)
    text = re.sub(r"\b(\d{1,2}):00\b", r"\1", text)  # "10:00 a.m." is said "ten a.m."
    text = re.sub(r"\b([ap])\.?\s?m\b\.?", r"\1m", text)
    text = re.sub(r"\$([\d,]+)\.(\d\d)\b", lambda m: f"{cardinal(int(m[1].replace(',', '')))} dollars and {cardinal(int(m[2]))} cents", text)
    text = re.sub(r"\$([\d,]+)", lambda m: f"{cardinal(int(m[1].replace(',', '')))} dollars", text)
    text = re.sub(r"\b(\d+)(st|nd|rd|th)\b", lambda m: ordinal(int(m[1])), text)
    text = re.sub(r"\b(" + "|".join(MONTHS) + r") (\d{1,2})\b", lambda m: f"{m[1]} {ordinal(int(m[2]))}", text)
    # Four or more digits without a $ are an ID or reference number, read digit by digit.
    text = re.sub(r"\b(\d{4,})\b", lambda m: " ".join(ONES[int(d)] for d in m[1]), text)
    return re.sub(r"\b(\d{1,3})\b", lambda m: cardinal(int(m[1])), text)


def words(text: str, english: bool):
    text = text.lower().replace("\u2019", "'").replace("\u2014", " ").replace("\u2013", " ")
    if english:
        text = spell_numbers(text)
    text = re.sub(r"[^\w\s']", " ", text)
    return text.split()


def word_errors(reference: str, hypothesis: str):
    """(word edits, reference words). Numbers are written out only for an English (ASCII) reference."""
    english = reference.isascii()
    ref, hyp = words(reference, english), words(hypothesis, english)
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h))
        previous = current
    return previous[-1], max(len(ref), 1)


def boosted_wav(wav: pathlib.Path):
    """(wav bytes, gain): the recording peak-normalized as the apps do before upload (normalizePeak
    in apps/desktop/src/core/audio/recorder.ts): one gain so the loudest sample sits at
    NORMALIZED_PEAK_DECIBELS, at most MAX_NORMALIZATION_GAIN_DECIBELS, never below 1."""
    with wave.open(str(wav)) as audio:
        params = audio.getparams()
        frames = audio.readframes(audio.getnframes())
    if params.sampwidth != 2:
        sys.exit(f"{wav.name}: expected 16-bit PCM, got {8 * params.sampwidth}-bit.")
    samples = array.array("h", frames)
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max((abs(sample) for sample in samples), default=0)
    if peak == 0:
        return wav.read_bytes(), 1.0
    gain = min(0x7FFF * 10 ** (NORMALIZED_PEAK_DECIBELS / 20) / peak, 10 ** (MAX_NORMALIZATION_GAIN_DECIBELS / 20))
    if gain <= 1:
        return wav.read_bytes(), 1.0
    # Rounded half away from zero, as the apps do; every scaled sample is at most the target.
    scaled = array.array("h", (int(math.copysign(math.floor(abs(sample) * gain + 0.5), sample)) for sample in samples))
    if sys.byteorder != "little":
        scaled.byteswap()
    out = io.BytesIO()
    with wave.open(out, "wb") as boosted:
        boosted.setparams(params)
        boosted.writeframes(scaled.tobytes())
    return out.getvalue(), gain


def upload_audio(wav: pathlib.Path, raw: bool):
    """(wav bytes to send, gain applied): boosted like the apps unless raw."""
    return (wav.read_bytes(), 1.0) if raw else boosted_wav(wav)


def audio_seconds(wav: pathlib.Path) -> float:
    with wave.open(str(wav)) as audio:
        return audio.getnframes() / audio.getframerate()


def summarize(rows, seconds_of):
    """One summary row from a model's results; seconds_of(passage) is that recording's length."""
    ok = [r for r in rows if not r["error"]]
    errors = sum(r["word_errors"] for r in ok)
    total = sum(r["reference_words"] for r in ok)
    audio = sum(seconds_of(r["passage"]) for r in ok)
    cost = sum(r["cost"] for r in ok)
    return {
        "wer": errors / total if total else None,
        "median_seconds": statistics.median(r["seconds"] for r in ok) if ok else None,
        "cost": cost,
        "cost_per_hour": cost / audio * 3600 if audio else None,
        "errors": len(rows) - len(ok),
    }


def score(result, refs):
    """Adds wer, word_errors and reference_words to a result (None when it errored)."""
    if result["error"]:
        result.update(wer=None, word_errors=None, reference_words=None)
    else:
        edits, total = word_errors(refs[result["passage"]], result["text"])
        result.update(wer=edits / total, word_errors=edits, reference_words=total)
    return result


def table_row(cells):
    return "| " + " | ".join(cells) + " |"


def summary_cells(s):
    return [f"{s['wer']:.1%}" if s["wer"] is not None else "—",
            f"{s['median_seconds']:.2f}" if s["median_seconds"] is not None else "—",
            f"{s['cost']:.5f}",
            f"{s['cost_per_hour']:.2f}" if s["cost_per_hour"] is not None else "—",
            str(s["errors"])]


SUMMARY_HEADER = ["WER", "Median latency (s)", "Cost ($)", "$/hour of audio", "Errors"]


def rescore(files):
    """Re-scores saved runs (no requests) and writes one combined table."""
    refs = references()
    lengths = {w.stem: audio_seconds(w) for w in (HERE / "recordings").glob("*.wav")}
    rows = []
    for file in files:
        saved = json.loads(pathlib.Path(file).read_text())
        run = pathlib.Path(file).stem
        by_model = {}
        for result in saved["results"]:
            if result["passage"] in refs and result["passage"] in lengths:
                by_model.setdefault(result["model"], []).append(score(dict(result), refs))
        for model, results in by_model.items():
            rows.append({"model": model, "run": run, "language": saved.get("language") or "auto-detect",
                         "audio": saved.get("audio", "raw"),
                         "clips": len(results), **summarize(results, lengths.__getitem__)})
    rows.sort(key=lambda r: (r["wer"] is None, r["wer"] or 0))
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    lines = [f"# STT re-score {stamp}", "", "Runs: " + ", ".join(pathlib.Path(f).name for f in files), "",
             table_row(["Model", "Run", "Audio", "Language", "Clips"] + SUMMARY_HEADER),
             table_row(["---"] * (5 + len(SUMMARY_HEADER)))]
    lines += [table_row([r["model"], r["run"], r["audio"], r["language"], str(r["clips"])] + summary_cells(r))
              for r in rows]
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    report = out / f"rescore-{stamp}.md"
    report.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[4:]))
    print(f"\nReport: {report}")


def key_from_env_file(path: pathlib.Path, use_sudo: bool):
    """OPENROUTER_API_KEY from a dotenv-style file (KEY=value lines; optional export/quotes).

    With use_sudo the file stays root-owned: sudo greps out only the key line, which is held in
    memory and never written anywhere.
    """
    pattern = "^(export )?OPENROUTER_API_KEY="
    if use_sudo:
        result = subprocess.run(["sudo", "/usr/bin/grep", "-E", "-m1", pattern, str(path)],
                                stdout=subprocess.PIPE, text=True)
        text = result.stdout
    elif not path.is_file():
        return None
    else:
        try:
            text = path.read_text()
        except PermissionError:
            sys.exit(f"Can't read {path}; add --sudo to read it as root.")
    for line in text.splitlines():
        name, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and name.strip() == "OPENROUTER_API_KEY":
            return value.strip().strip("'\"") or None
    return None


def zdr_status(models):
    """For each model: "all N" / "k of N" / "none" of its endpoints on the ZDR list (public API).

    OpenRouter doesn't apply per-request provider routing to transcription, so a model with any
    non-ZDR endpoint can land there unless ZDR is enforced in the account's privacy settings.
    """
    with urllib.request.urlopen(ZDR_LIST, timeout=TIMEOUT_SECONDS) as response:
        zdr = {entry["name"] for entry in json.load(response)["data"]}
    status = {}
    for model in models:
        try:
            with urllib.request.urlopen(MODEL_ENDPOINTS.format(model=model), timeout=TIMEOUT_SECONDS) as response:
                endpoints = json.load(response)["data"]["endpoints"]
        except Exception as error:
            status[model] = f"unknown ({type(error).__name__})"
            continue
        covered = sum(1 for e in endpoints if e["name"] in zdr)
        status[model] = "none" if covered == 0 else f"all {covered}" if covered == len(endpoints) else f"{covered} of {len(endpoints)}"
    return status


def transcribe(key: str, model: str, audio: bytes, language):
    body = {
        "model": model,
        "input_audio": {"data": base64.b64encode(audio).decode(), "format": "wav"},
        "temperature": 0,
    }
    if language:
        body["language"] = language
    request = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.load(response)
        return {"text": payload.get("text", ""), "seconds": time.monotonic() - started,
                "cost": (payload.get("usage") or {}).get("cost") or 0, "error": None}
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        return {"text": "", "seconds": time.monotonic() - started, "cost": 0, "error": f"HTTP {error.code}: {detail}"}
    except Exception as error:  # network errors, timeouts
        return {"text": "", "seconds": time.monotonic() - started, "cost": 0, "error": f"{type(error).__name__}: {error}"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    parser.add_argument("--env-file", type=pathlib.Path, default=HERE / ".env",
                        help="file with an OPENROUTER_API_KEY=... line (default: .env next to this script)")
    parser.add_argument("--sudo", action="store_true",
                        help="read --env-file through sudo (for a root-owned secrets file)")
    parser.add_argument("--language", help="ISO-639-1 code, e.g. en (default: auto-detect)")
    parser.add_argument("--speak", help="record this sentence with macOS `say` and use it instead of recordings/")
    parser.add_argument("--voice", help="the `say` voice for --speak, e.g. Yuna for Korean (default: the system voice)")
    parser.add_argument("--raw", action="store_true",
                        help="send the recordings as captured, without the apps' upload boost")
    parser.add_argument("--rescore", nargs="+", metavar="RESULTS_JSON",
                        help="re-score saved results/*.json runs into one table; sends no requests")
    args = parser.parse_args()
    if args.rescore:
        rescore(args.rescore)
        return

    key = os.environ.get("OPENROUTER_API_KEY") or key_from_env_file(args.env_file.expanduser(), args.sudo)
    if not key:
        sys.exit(f"No OPENROUTER_API_KEY in the environment or in {args.env_file}.")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    if args.speak:
        wav = out / f"{stamp}-spoken.wav"
        subprocess.run(["say", "-o", str(wav), "--data-format=LEI16@16000"]
                       + (["-v", args.voice] if args.voice else []) + [args.speak], check=True)
        refs = {wav.stem: args.speak}
        wavs = [wav]
    else:
        refs = references()
        wavs = sorted((HERE / "recordings").glob("*.wav"))
        wavs = [w for w in wavs if w.stem in refs]
        if not wavs:
            sys.exit("No recordings matching passages.txt in recordings/ (run record.py first).")

    zdr = zdr_status(args.models)
    for model, state in zdr.items():
        if not state.startswith("all"):
            print(f"  ⚠️  {model}: ZDR endpoints {state}")
    uploads = {wav.stem: upload_audio(wav, args.raw) for wav in wavs}
    audio_label = "raw" if args.raw else "boosted"
    gains = sorted(20 * math.log10(gain) for _, gain in uploads.values())
    print(f"Audio: {audio_label}" + ("" if args.raw else f", gain {gains[0]:+.1f} to {gains[-1]:+.1f} dB"))
    jobs = [(model, wav) for model in args.models for wav in wavs]
    print(f"{len(args.models)} models × {len(wavs)} recordings = {len(jobs)} requests…")
    results = {}
    with concurrent.futures.ThreadPoolExecutor(PARALLEL_REQUESTS) as pool:
        futures = {pool.submit(transcribe, key, m, uploads[w.stem][0], args.language): (m, w.stem) for m, w in jobs}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            model, pid = futures[future]
            result = score({"passage": pid, **future.result()}, refs)
            results[(model, pid)] = result
            print(f"  {done}/{len(jobs)} {model} {pid} {'ERROR' if result['error'] else 'ok'}")

    lengths = {wav.stem: audio_seconds(wav) for wav in wavs}
    summary = [{"model": model, "zdr": zdr[model],
                **summarize([results[(model, w.stem)] for w in wavs], lengths.__getitem__)}
               for model in args.models]
    summary.sort(key=lambda s: (s["wer"] is None, s["wer"] or 0))

    audio_line = ("Audio: raw (as recorded)" if args.raw else
                  f"Audio: boosted like the apps (peak {NORMALIZED_PEAK_DECIBELS} dBFS, gain "
                  f"{gains[0]:+.1f} to {gains[-1]:+.1f} dB)")
    lines = [f"# STT comparison {stamp}", "", f"Language: {args.language or 'auto-detect'}", "", audio_line, "",
             table_row(["Model", "ZDR endpoints"] + SUMMARY_HEADER), table_row(["---"] * (2 + len(SUMMARY_HEADER)))]
    lines += [table_row([s["model"], s["zdr"]] + summary_cells(s)) for s in summary]
    for wav in wavs:
        lines += ["", f"## {wav.stem}", "", f"**Reference:** {refs[wav.stem]}", ""]
        for s in summary:
            r = results[(s["model"], wav.stem)]
            shown = f"⚠️ {r['error']}" if r["error"] else f"{r['text']}  _(WER {r['wer']:.0%}, {r['seconds']:.2f}s)_"
            lines.append(f"- **{s['model']}**: {shown}")
    report = out / f"{stamp}.md"
    report.write_text("\n".join(lines) + "\n")
    (out / f"{stamp}.json").write_text(json.dumps(
        {"language": args.language, "audio": audio_label, "summary": summary,
         "results": [{"model": m, "passage": p, **r} for (m, p), r in results.items()]}, indent=2))
    print("\n" + "\n".join(lines[6:8 + len(summary)]))
    print(f"\nFull report: {report}")


if __name__ == "__main__":
    main()
