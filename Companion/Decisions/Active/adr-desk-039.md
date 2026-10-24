## ADR-DESK-039: A shorter wait between the release and the text

**Context:** Owner, 2026-09-29: two to three seconds passed between letting go of the key and the
text appearing. Measured end to end the same day (the app's log against the backend's per-request
timeline, the Mac's clock corrected): the app itself adds nothing after the reply (the paste starts
in the same millisecond), so the wait was the release tail (300 ms), the connection and upload
(45–175 ms), the backend's sign-in, entitlement and quota checks (about 90 ms, but 365 ms on the
first dictation after a pause), the transcription (250–700 ms) and the cleanup (300–470 ms). One
dictation that day failed outright: the speech model's provider answered 429 (rate limited), the
backend passed it on as a 502, and the recording was lost. The owner approved all four changes below,
and asked that a server error be retried with a note on the pill, "so that the user doesn't have to
say it again". Before the audio was compressed, the owner asked whether compressing would itself add
time; measured first (below).

**Decision:**
- **Warm-up at key-down.** Every hold sends `GET /whoami` with the sign-in
  (`TranscriptionClient.warmUp`, under `withFreshToken`) while the user speaks, so the transcription
  after the release finds the connection open, the token refreshed if it was about to expire, and the
  backend's token check and entitlement warm. Best effort: nothing waits for it, and a failure is
  logged only.
- **FLAC upload.** The recording is uploaded as FLAC (`format: "flac"`, which the backend already
  accepted), lossless, at about half WAV's size. `FLACEncoder` (in `src/core`, no dependency) encodes
  each 4,096-sample frame (256 ms) as the audio arrives, so the release leaves only the last partial
  frame to encode. Measured before it was adopted: the whole recording takes about 1.4 ms per second
  of audio to encode (10–18 ms for 7 s, 160 ms for 120 s), against about 90 ms of upload saved for
  7 s and 1.5 s for 120 s on the owner's connection; encoding while recording removes even that cost.
  *(Later (ADR-DESK-040): the recording is peak-normalized first, which needs all of it, so it is
  encoded at the release, about 10 ms for a typical dictation.)*
  The reference `flac` decoder gave back the exact samples. The debug "Play Last Recording" file
  stays WAV.
- **Retry on a server error.** A transcription that fails with a 5xx (the speech model behind the
  backend rate limited, overloaded or failed) or a dropped connection is sent again after
  `transcriptionRetryDelays` (0.5 s, then 1.5 s; *eight tries over about a minute since 2026-10-03,
  see the amendment below*), the same recording and request, while the pill
  shows "Server error, retrying…" (the `retrying` phase), back to transcribing once a retry
  answers; after the last it fails with the server's error as before. Nothing else is retried:
  signed out, no subscription, over quota or throttled (the backend's own 429), a refused request,
  or a timeout, here or the backend's own 504 (either already waited: `transcriptionRequestTimeout`,
  or the backend's 30 s for the speech model; retrying a 504 would hold the hotkey for 1.5 minutes). Canceling during the wait sends nothing more. Both modes share it,
  since agent mode's request starts with the same transcription.
  *(Later, owner 2026-10-02: the note shows only once `transcriptionRetryNoticeDelay` (2 s) has
  passed since the first failure, so a retry that answers sooner, as most brief rate limits do, shows
  nothing but a dictation taking a moment longer. The retries themselves are unchanged. A note that
  has not come up by the time a retry answers, the last fails or the dictation is canceled never
  does.)*
  *(Later still, owner 2026-10-02: from the first server error until a retry answers or the
  dictation ends, `DictationController.isRetrying` is true, and the thinking circle's arc and track
  move `thinkingRetryColorShift` (0.3) along the blue → purple gradient: a hint of the retry while the
  note waits its 2 s. The hint belongs to the transcription that hit the error: it shows only while
  that transcription's dictation is the current one and it is not canceled, and only that
  transcription clears it, so a canceled dictation's or a dropped spoken answer's retry still in flight
  neither tints what follows nor, answering late, clears its own hint (owner: purple if and only if
  this dictation hit a server error). Tests: `controller.test.ts` › a canceled dictation's retry
  neither shows on nor clears the next dictation's; a dropped answer's retry still in flight stops
  saying it is retrying; each answer spoken aloud starts with no voice heard.)*
  *(Later, owner 2026-10-03 (ADR-DESK-048): the shift toward purple was too close to blue to notice;
  the arc and track now fade to fuchsia, `palette.retryArcStart` → `palette.retryArcEnd`, over
  `colorTransitionSeconds`, and back when a retry answers.)*
- **Release tail 150 ms** (was 300 ms), owner's choice.

**Consequences:**
- Every hold, a tap included, sends one small `GET /whoami`. For a user without an entitlement it can
  grant the signup trial, as the transcription request it precedes would.
- Node's `fetch` closes an idle connection after 4 s, so a dictation longer than that may upload over
  a new connection; the backend's warmth outlasts it.
- A retried request whose first attempt did reach the model but lost its reply (a dropped connection
  after the backend answered) is transcribed, and counted, twice. A 5xx is never counted: the backend
  reports usage only on success.
- Supersedes ADR-DESK-005's "A failed transcription loses that recording (no retry queue yet)" for
  server errors; its WAV upload is now FLAC.

**Amendment 2026-10-03 — more and longer retries (owner).** *"We definitely need more retries …
lengthen them, and we should not lose the end."* Measured the same day, the speech model's provider
refused about one try in three as rate limited, in bursts of seconds, and two tries 2 s apart could
not outlast one. `transcriptionRetryDelays` is now 0.5, 1.5, 3, 5, 10, 10, 15 and 15 s, about a
minute in all, with the retry note up from 2 s; the user can cancel at any time. A recording's 504
is still not retried (above). A long dictation's chunk after the release retries its 504 too, as
while recording (ADR-DESK-049).
*(Later the same day: the backend now retries the speech model's own 429 for its 30 s window (10 s
since 2026-10-04) and then answers 429 `transcription_rate_limited`, where it answered 502 (backend ADR-022). The app reads
that code as a failure of the speech model, not this account's limit (`BackendError` `failed`, 429;
the account's 429s stay `rateLimited`). Like a 504, the backend already waited, so a recording does
not try it again; a long dictation's chunk does, while recording and after the release
(`backendWaited`, ADR-DESK-049).)*
*(2026-10-04, owner: "retry should not have changed". That made a recording stop retrying what it
had always retried: the speech model's rate limit, answered as a 502 until the backend began
retrying it itself. A recording tries that 429 again as it did the 502 (`isServerError`); only its
504 is still not retried (`backendTimedOut`). A long dictation's chunk retries both, as before.)*

**Amendment 2026-10-08 — one 10 s deadline from the release (owner).** *"Nobody waits for dictation
more than 10"* seconds: the app and the backend kept trying for minutes (a 45 s request, then eight
retries over about a minute, each try up to the backend's 30 s). Now a dictation's whole wait for its
text, from the release, is `transcriptionDeadline` (10 s): the request, every retry and its waits, a
long dictation's chunks still out at the release and its polish all fall inside it
(`DictationController.withinDeadline`). Past it, the requests and waits are called off and the
dictation fails at once as a request that timed out ("TabMail took too long to answer. Try again.");
a long dictation pastes the chunks that came in and says the end is missing (`partlyTranscribedMessage`,
ADR-DESK-049), and is not polished; one whose chunks all came in has its polish get only what is left
of the 10 s, never more than `chunkPolishTimeout`. A spoken answer to the chat window's question gets the same 10 s from its release.
Every one of these counts from the release, not from the upload after the release tail. A transcription
past its deadline may still be in a retry nothing calls off (the sign-in refresh it waits on takes no
signal); its retry note and late answer no longer change the phase once its signal aborts
(`retryNotice`), so the failure stands and the next hold starts. `transcriptionRetryDelays`
is cut to 0.5, 1.5 and 3 s (what fits). `transcriptionRequestTimeout` stays 45 s on purpose: after
the release the deadline ends the wait anyway, and before it a long dictation's chunk may take longer
than 10 s while the user goes on (a 10 s request timeout there gave the chunk up for good, losing the
dictation; found in review). The
backend answers within about 9.5 s of receiving the upload (the release tail, the screen read's wait
and the upload come first): 8 s for the speech model, 429 retries for its first 6 s, then the 1.5 s
cleanup (backend ADR-022, amendment 2026-10-08). Supersedes the 2026-10-03 "about a minute" of
retries. Agent mode's run after the transcript stays without a deadline (ADR-DESK-055). Tests:
`controller.test.ts` › gives up at its deadline, however many retries are left; a request unanswered
at the deadline is called off; a retry still running past the deadline leaves the failure alone, and
the next hold starts; its deadline counts from the release; the chunks' deadline counts from
the release; a chunk answering after the deadline's length while the user still
dictates is kept; a chunk not in by the deadline …; a chunk failing on every try gives up at the
deadline; no chunk in by the deadline: the dictation fails as timed out; chunks in, the last out of
time: no polish is sent; chunks all in after the deadline
passed: no polish is sent; the polish stops at the dictation's
deadline; an answer that comes to nothing (not transcribed in time; out of time from the release).

