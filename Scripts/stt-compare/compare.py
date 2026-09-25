#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Transcribe every recording with several OpenRouter speech-to-text models and score them.

Needs OPENROUTER_API_KEY, either in the environment or as a KEY=value line in an env file
(--env-file, default Scripts/stt-compare/.env, gitignored). The key is never printed or written.
Sends the same request shape the TabMail backend sends.

    python3 Scripts/stt-compare/compare.py
    python3 Scripts/stt-compare/compare.py --env-file path/to/secrets.env
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
# Speech-to-text models whose every OpenRouter endpoint is on the Zero Data Retention list
# (checked 2026-09-24 via /api/v1/endpoints/zdr; re-checked live on every run, see the ZDR
# column). Left out: models with no ZDR endpoint (OpenAI first-party gpt-*/whisper-1, Google
# AI Studio gemini-3.5-transcribe, Meta, Alibaba qwen3-asr-flash, xAI grok-stt) and the two
# Azure mai-transcribe models (ZDR, but their listed price has no clear unit; add them with
# --models if you want them).
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
    "assemblyai/universal-3-5-pro",
    "deepgram/nova-3",
    "fish-audio/transcribe-1",
    "fish-audio/transcribe-1-pro",
    "google/chirp-3",
]
ZDR_LIST = "https://openrouter.ai/api/v1/endpoints/zdr"
MODEL_ENDPOINTS = "https://openrouter.ai/api/v1/models/{model}/endpoints"
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


def key_from_env_file(path: pathlib.Path):
    """OPENROUTER_API_KEY from a dotenv-style file (KEY=value lines; # comments; optional quotes)."""
    if not path.is_file():
        return None
    try:
        text = path.read_text()
    except PermissionError:
        sys.exit(f"Can't read {path}. Copy just the key line into a file you own instead (see README).")
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
    parser.add_argument("--env-file", type=pathlib.Path, default=HERE / ".env",
                        help="file with an OPENROUTER_API_KEY=... line (default: .env next to this script)")
    parser.add_argument("--language", help="ISO-639-1 code, e.g. en (default: auto-detect)")
    args = parser.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY") or key_from_env_file(args.env_file.expanduser())
    if not key:
        sys.exit(f"No OPENROUTER_API_KEY in the environment or in {args.env_file}.")
    refs = references()
    wavs = sorted((HERE / "recordings").glob("*.wav"))
    wavs = [w for w in wavs if w.stem in refs]
    if not wavs:
        sys.exit("No recordings matching passages.txt in recordings/ (run record.py first).")

    zdr = zdr_status(args.models)
    for model, state in zdr.items():
        if not state.startswith("all"):
            print(f"  ⚠️  {model}: ZDR endpoints {state}")
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
            "zdr": zdr[model],
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
             "| Model | ZDR endpoints | WER | Avg latency (s) | Cost ($) | Errors |", "|---|---|---|---|---|---|"]
    for s in summary:
        wer_text = f"{s['wer']:.1%}" if s["wer"] is not None else "—"
        secs = f"{s['seconds']:.2f}" if s["seconds"] is not None else "—"
        lines.append(f"| {s['model']} | {s['zdr']} | {wer_text} | {secs} | {s['cost']:.5f} | {s['errors']} |")
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
