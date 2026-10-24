## ADR-DESK-040: The recording is peak-normalized before it is uploaded

**Context:** Owner, 2026-09-29, after a speech-to-text comparison (`Scripts/stt-compare`, the 10
recordings of `passages.txt`, 3 runs each, word error rate after the Whisper English text
normalizer): the recordings, made on a Mac's microphone with no automatic gain (the app turns it off,
as OpenWhispr does), peak at only −22 to −29 dBFS. Scaled so their loudest sample sits at −3 dBFS,
the backend's model (MAI-Transcribe-2) made 9.5 % word errors against 11.0 % as recorded, and one
Whisper Large V3 host that dropped most quiet speech as silence (79 %) came down to 19 %. The owner
asked for the same boost in this app and the iOS app. OpenWhispr's desktop app sends its recording
unscaled; its mobile app asks its own server to normalize.

**Decision:**
- `AudioRecorder.finish` scales the whole recording by one gain so its loudest sample sits at
  `normalizedPeakDecibels` (−3 dBFS; the headroom keeps any sample from clipping), boosting by at
  most `maxNormalizationGainDecibels` (30 dB, so near-silence isn't raised into loud noise; the
  quietest measured recording needed +26 dB) and never cutting a louder one (`normalizePeak`).
- Peak normalization, one gain for the whole recording: the transform that was measured, and it
  changes nothing but the level. Not automatic gain control (the microphone's own stays off: on
  Windows Chromium's changes the system input volume, as OpenWhispr found), and not loudness
  (RMS/LUFS) normalization, which would need a limiter to keep peaks from clipping.
- The FLAC upload is therefore encoded at the release instead of while recording (ADR-DESK-039):
  about 1.4 ms per second of audio. The debug "Play Last Recording" file and `Recording.pcm` are the
  normalized samples, what the backend hears. `peakLevel` stays the level as captured; the debug log
  adds the gain.
- The iOS app does the same (its `AudioRecorder`), with the same two values.

**Consequences:**
- About 10 ms more between the release and the upload for a typical dictation (160 ms at the 120 s
  cap).
- One loud click (a key press) sets the gain, so a recording with a click louder than the speech is
  boosted less. The measured gain came from speech-only recordings.

