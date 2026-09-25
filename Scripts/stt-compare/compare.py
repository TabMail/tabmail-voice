#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Transcribe every recording with several OpenRouter speech-to-text models and score them.

Needs OPENROUTER_API_KEY in the environment (run it in your own terminal; the key is never
printed or written). Sends the same request shape the TabMail backend sends.

    python3 Scripts/stt-compare/compare.py
    python3 Scripts/stt-compare/compare.py --language en
    python3 Scripts/stt-compare/compare.py --models openai/whisper-large-v3-turbo deepgram/nova-3

Writes results/<timestamp>.md (summary table + every transcript) and .json.
WER = word error rate against passages.txt after lower-casing and stripping punctuation, so it
ignores formatting; read the transcripts for punctuation, casing and number formatting.
"""
import argparse
import base64
import concurrent.futures
import datetime
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
DEFAULT_MODELS = [
    "openai/whisper-large-v3-turbo",
    "openai/whisper-large-v3",
    "qwen/qwen3-asr-1.7b",
    "mistralai/voxtral-mini-transcribe",
    "assemblyai/universal-3-5-pro",
    "deepgram/nova-3",
    "openai/gpt-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "google/gemini-3.5-transcribe",
]
TIMEOUT_SECONDS = 60
PARALLEL_REQUESTS = 6


def references():
    refs = {}
    for line in (HERE / "passages.txt").read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            pid, text = (part.strip() for part in line.split("|", 1))
            refs[pid] = text
    return refs


def words(text: str):
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^\w\s']", " ", text)
    return text.split()


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = words(reference), words(hypothesis)
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h))
        previous = current
    return previous[-1] / max(len(ref), 1)


def transcribe(key: str, model: str, wav: pathlib.Path, language):
    body = {
        "model": model,
        "input_audio": {"data": base64.b64encode(wav.read_bytes()).decode(), "format": "wav"},
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
    parser.add_argument("--language", help="ISO-639-1 code, e.g. en (default: auto-detect)")
    args = parser.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("Set OPENROUTER_API_KEY first.")
    refs = references()
    wavs = sorted((HERE / "recordings").glob("*.wav"))
    wavs = [w for w in wavs if w.stem in refs]
    if not wavs:
        sys.exit("No recordings matching passages.txt in recordings/ (run record.py first).")

    jobs = [(model, wav) for model in args.models for wav in wavs]
    print(f"{len(args.models)} models × {len(wavs)} recordings = {len(jobs)} requests…")
    results = {}
    with concurrent.futures.ThreadPoolExecutor(PARALLEL_REQUESTS) as pool:
        futures = {pool.submit(transcribe, key, m, w, args.language): (m, w.stem) for m, w in jobs}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            model, pid = futures[future]
            result = future.result()
            result["wer"] = None if result["error"] else wer(refs[pid], result["text"])
            results[(model, pid)] = result
            print(f"  {done}/{len(jobs)} {model} {pid} {'ERROR' if result['error'] else 'ok'}")

    summary = []
    for model in args.models:
        rows = [results[(model, w.stem)] for w in wavs]
        ok = [r for r in rows if not r["error"]]
        summary.append({
            "model": model,
            "wer": sum(r["wer"] for r in ok) / len(ok) if ok else None,
            "seconds": sum(r["seconds"] for r in ok) / len(ok) if ok else None,
            "cost": sum(r["cost"] for r in ok),
            "errors": len(rows) - len(ok),
        })
    summary.sort(key=lambda s: (s["wer"] is None, s["wer"] or 0))

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    lines = [f"# STT comparison {stamp}", "", f"Language: {args.language or 'auto-detect'}", "",
             "| Model | WER | Avg latency (s) | Cost ($) | Errors |", "|---|---|---|---|---|"]
    for s in summary:
        wer_text = f"{s['wer']:.1%}" if s["wer"] is not None else "—"
        secs = f"{s['seconds']:.2f}" if s["seconds"] is not None else "—"
        lines.append(f"| {s['model']} | {wer_text} | {secs} | {s['cost']:.5f} | {s['errors']} |")
    for wav in wavs:
        lines += ["", f"## {wav.stem}", "", f"**Reference:** {refs[wav.stem]}", ""]
        for s in summary:
            r = results[(s["model"], wav.stem)]
            shown = f"⚠️ {r['error']}" if r["error"] else f"{r['text']}  _(WER {r['wer']:.0%}, {r['seconds']:.2f}s)_"
            lines.append(f"- **{s['model']}**: {shown}")
    report = out / f"{stamp}.md"
    report.write_text("\n".join(lines) + "\n")
    (out / f"{stamp}.json").write_text(json.dumps(
        {"language": args.language, "summary": summary,
         "results": [{"model": m, "passage": p, **r} for (m, p), r in results.items()]}, indent=2))
    print("\n" + "\n".join(lines[4:6 + len(summary)]))
    print(f"\nFull report: {report}")


if __name__ == "__main__":
    main()
