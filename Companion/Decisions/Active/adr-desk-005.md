## ADR-DESK-005: Speech-to-text on the TabMail backend (OpenRouter), shared by all platforms

**Context:** Owner, 2026-09-24: dictation should use an OpenRouter speech-to-text model via our
backend, so the same engine serves desktop, iOS and Thunderbird later.

**Decision:** The app records 16 kHz mono 16-bit PCM (`AudioRecorder`), wraps it in WAV
(`WAVEncoder`; FLAC since ADR-DESK-039) and posts it as base64 JSON to the TabMail backend's `POST /dictation/transcribe`,
which relays it to an OpenRouter speech-to-text model. Requires TabMail sign-in (email one-time
code, same flow as iOS) and an active subscription; dictation counts toward the account's usage.

**Rationale:** One engine and one model switch (backend config) for every client; far better
multilingual accuracy than Apple's on-device model.

**Consequences:**
- Audio leaves the Mac. The TabMail backend stores and logs neither audio nor text.
- No live transcript while speaking (batch upload on release); latency ≈ upload + model time.
- Every held recording is uploaded; an empty transcript shows "Didn't catch that." There is no
  loudness gate: on a Studio Display mic, speech measured only 3–10 dB above the room noise
  (−30 to −40 dB RMS against about −45 dB), so the earlier fixed −32 dB gate rejected nearly
  all real speech, and a gate relative to the noise floor couldn't separate a quiet sentence
  from silence either. The model, chosen by comparison with `Scripts/stt-compare/`, handles
  that input. Recording continues `releaseTailDuration` after the key is released so the last
  word isn't clipped.
- ~~Recording auto-stops at `maxRecordingDuration` (5 min ≈ 9.6 MB, under the backend's 10 MiB upload limit).~~
  Superseded 2026-09-27: auto-stops at 120 s, below.
- A failed transcription loses that recording (no retry queue yet). (Since ADR-DESK-039 a server
  error or dropped connection is retried twice before it does.) Chunking long dictations
  (transcribe ~20–30 s pieces as they complete, retry a failed piece alone) is tracked in
  issue #1 (P3). (Done in ADR-DESK-049: cut at pauses, sent while the user speaks.)
- macOS 15+ (the macOS 26 floor existed only for `SpeechAnalyzer`).

**Amendment 2026-09-27 — the length cap is 120 s.** Owner: *"there was a bug before about this
recording limit being five minutes instead of just two, which is the 120 second limit that fits the
back end… we should do it for two minutes for now until the chunking arrives in the back end."* The
5-minute cap fitted the backend's 10 MiB upload limit, but the backend's transcription model takes
at most 120 s of audio (backend ADR-022), so a longer recording was uploaded only to fail.
`maxRecordingDuration` is 120 s in both apps (`DictationConfig`, `config.ts`), for a hold and
hands-free alike; the recorder keeps nothing past it. Raise it once chunking (issue #1) lands.

**Amendment 2026-10-03 — 10 minutes, in chunks.** Chunking arrived on the app's side (ADR-DESK-049):
a dictation is cut into chunks under the backend's 120 s and sent while the user speaks, so
`maxRecordingDuration` is 10 minutes. A spoken answer to a confirmation stays one upload, capped at
`maxUnchunkedDuration` (120 s).

