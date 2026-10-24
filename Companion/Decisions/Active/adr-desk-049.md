## ADR-DESK-049: Long dictations, cut into chunks at pauses and sent while the user speaks

**Context:** A dictation stopped at 120 s, the most the backend's transcription takes at once
(ADR-DESK-005, amended 2026-09-27; issue #1). Owner, 2026-10-03: the recording can be longer; the app
splits it into parts under the backend's limit and joins their texts. OpenWhispr, looked at for
comparison, cuts only after recording, into fixed 240 s pieces with no overlap, and joins them with
spaces, so a word at a cut is split and lost; its own issues propose cutting at the quietest moment.

**Decision:** `maxRecordingDuration` is 10 minutes. As it is recorded, a dictation is cut into
chunks (`Chunker`, `src/core/audio/chunker.ts`), each sent at once, as a whole request with its own
cleanup (backend ADR-027), while the user goes on; the texts are joined in order at the release
(`joinChunkTexts`, `src/core/dictation/chunkJoin.ts`). A dictation never cut is one upload, as before.

- **Where it is cut (owner, 2026-10-03: "a second pause should be enforced… only after 10s+ for
  chunks").** Loudness is read in `chunkFrameDuration` frames against the recording's own levels,
  never a fixed one (ADR-DESK-005 found none): the 10th percentile of its frames is the room, the
  90th percentile of those at least `chunkMinimumRange` above it the voice, and a frame less than
  `chunkPauseLevel` of the way up is quiet; a quiet run shorter than `chunkSpeechGap` (between
  syllables and words) is speech, and louder frames no longer than `chunkPauseBlip` (40 ms) inside a
  quiet run are quiet. Once a chunk holds `chunkMinimumSpeech` (10 s) of speech, it is cut
  in the middle of the next `chunkPauseDuration` (1 s) of quiet. Measured on the owner's recordings
  with room gaps between them: 1.1 s and 1.5 s gaps cut, always inside the gap; 0.7 s gaps never;
  reading the whole of a 10-minute recording takes 15–22 ms. Those gaps were spliced room audio; a
  real dictation's pauses are not that clean (owner's test, 2026-10-03: a 32 s dictation with
  several 1–2 s pauses after 10 s+ of speech was never cut). On its USB microphone the room was
  −31.5 dB, the voice −19 dB, the line −27.8 dB, and every pause was 80–90% quiet, the rest room
  noise 0–4 dB over the line a frame or two at a time; the longest all-quiet run was 0.54 s. Letting
  blips of up to `chunkPauseBlip` through cut it at 13.5 s and 27.4 s, both inside its pauses.
  The tolerance is kept to a plosive's burst, shorter than any vowel, since a cut must be in a
  pause for sure (owner, 2026-10-03: "really high precision, even if some recall could be lower");
  louder stretches past it end the pause as before. The levels are relative, so speech
  much softer than what came before, with few frames at the room's level, can read as quiet: a
  pause cut can land in it and split a word or two, with no overlap to recover them (reproduced
  with synthetic audio in review, 2026-10-03; real speech dips to the room between words). Every
  chunk is still sent.
- **No pause (owner: "if a continuous speech goes over 2 minutes… overlapping things").** A chunk
  that reaches `chunkMaxDuration` (105 s, under the backend's 120 s) is cut at the quietest
  `chunkForcedCutWindow` of its last `chunkForcedCutSearch`, and the next chunk starts
  `chunkOverlapSpeech` (15 s) of speech earlier, at most `chunkMaxOverlap`. The join keeps the
  words both heard once: it matches the longest run of at least `chunkOverlapMinimumRun` words
  (lower case, letters and digits only) within `chunkOverlapSearchWords` of the seam, keeping the
  run's first word as the earlier chunk wrote it and the rest as the later one did (owner's smoke
  test, 2026-10-03: "capitalization mid breaks"; the later chunk's text starts with a capital, as
  any text does, so taking its copy wrote "you can Test the" at every overlap seam), and with no
  such run joins the two whole (owner: "better than losing things"). A chunk overlaps only the one
  just before it: after an empty one (a long silence) it is joined whole, or matching it
  against an earlier chunk's words would cut out the speech between.
- **The join.** An ellipsis where two chunks meet is the cut's pause, written by the model, and is
  taken out; one inside a chunk stays. Chunks join with a space, or none where Chinese, Japanese,
  Thai, Lao, Khmer or Burmese text meets. Each chunk's cleaned text is pasted (its transcript where
  the cleanup failed, ADR-DESK-008).
- **The polish (owner, 2026-10-03: "one final cleanup pass after the full dictation, even in the
  chunked case… a little bit wasteful, but nice to have"; "a final polished pass if time permits… not
  longer than 5 seconds"; "this should not change any of the backend mechanisms").** In dictation
  mode, a text of two chunks or more (joined as above) goes once more through the same cleanup
  prompt, `system_prompt_dictate_cleanup`, which the app calls itself at `POST /completions/chat`
  (as before ADR-DESK-039's amendment of 2026-09-29), with the dictation's cleanup variables and the
  joined text as its `dictation`, under the dictation's account. Its reply is pasted if it comes
  within `chunkPolishTimeout` (5 s) of the chunks being in; one that fails, comes back empty or runs
  out of time (its request is canceled) leaves the joined text to be pasted, as a failed cleanup
  leaves the transcript (ADR-DESK-008). The owner chose to polish the cleaned text, not to clean the
  raw transcript a second way, and the 5 s over a longer wait. Agent mode polishes nothing; a single
  recording, or one chunk left before a chunk that gave up, already had its whole cleanup.
- **Every chunk is sent**, a long silence's too (owner, 2026-10-03, on review: "send every chunk"):
  the model decides what was said, as for one recording (ADR-DESK-005: no loudness gate). Chunks
  judged silent by their loudness were skipped at first, but speech much softer than the speech
  before it fell under the recording's levels and was lost without a word; the cost of sending is a
  request per 105 s of silence, and a silence the model may hear a stray word in.
- **Each chunk is normalized on its own** (ADR-DESK-040) and FLAC-encoded as it is cut (ADR-DESK-039).
- **Nothing is recorded after the finish** (2026-10-04, from review; owner: "close the edge case"):
  `AudioRecorder` takes no audio once finished, so nothing appended late could cut and send a chunk
  after the last. Here the capture already stops delivering before the finish (`SessionAudioCapture`
  drops its callback at once), so this keeps "finish is final" true for any capture source; on iOS a
  tap block can still run as the microphone stops, and the same guard closes a real race there.
- **Retries (owner: "continuous retries until even the last chunk or the user release is done…
  until the final give up").** While the user dictates, a chunk's server error, dropped connection,
  backend timeout (504) or the speech model's rate limit outlasting the backend's own 10 s of retries
  (429 `transcription_rate_limited`, backend ADR-022; found in review 2026-10-03, where one such 429
  threw away the rest of a dictation) is tried again after each of `chunkRetryDelays`, the last repeating,
  quietly: nobody waits for it yet. From the release, a chunk still failing gets the
  `transcriptionRetryDelays` tries one recording gets, about a minute of waits *(since 2026-10-08
  all inside the dictation's 10 s `transcriptionDeadline` from the release; a chunk not in by then
  gives up, ADR-DESK-039 amendment 2026-10-08)* (ADR-DESK-039, amendment
  2026-10-03; each try the backend holds, up to 30 s for a 504 and about 10 s for that 429, adds that time,
  so a chunk failing that way every time keeps the pill transcribing for up to about 5.5 minutes,
  9 tries × 30 s plus the waits, until the user cancels; found in review, 2026-10-03), with the pill's retry note, on the same failures, a 504 and that 429 included: the last chunk is sent
  at the release, so its backend timeout comes after it (owner: "we should not lose the end").
  Any other failure (signed out, over quota or the account's own rate limit, refused) gives up at once.
- **A chunk that gives up (owner: "if it continuously fails completely, paste nothing… paste only
  the up to successful part").** The chunks before the first that gave up are pasted, and the pill
  says `partlyTranscribedMessage` (`partlyCopiedMessage` when the text was copied instead, the user
  having switched apps, ADR-DESK-042); the chunks after it are not, so the text has no hole. Once
  the text is known, the retry note ends and the chunks still running are cancelled, before the
  paste or the agent's run. The first
  chunk giving up loses the dictation, as one recording's failure does. Agent mode carries out a
  request whole or not at all: a lost chunk fails it.
- Cancelling cancels every chunk's request. The chunks already answered have been transcribed and
  cleaned up, as any dictation is.
- A spoken answer to a confirmation (ADR-DESK-036) stays one upload, capped at
  `maxUnchunkedDuration` (120 s).

**Consequences:**
- A long dictation's text is ready about as soon as its last chunk is transcribed: the earlier ones
  are done while the user speaks.
- The audio goes to the same place as before and none of it is stored (root ADR-004), but it leaves
  sooner: a long dictation cancelled after a cut has already sent the chunks before it, each with
  the cleanup's context (the text around the cursor and on screen, as every dictation sends; before
  chunking, a cancelled hold sent nothing). The welcome wizard's consent page says a long dictation
  is sent in parts while the user speaks; users who consented before are told once, by a tip under
  the pill at their next dictation, ahead of the other tips (`longDictations`: "New: dictate up to
  10 minutes, sent in parts as you talk"), and are never asked again. Owner, 2026-10-03: a launch
  dialog was "poorly formatted… too long and sloppy"; "an ordinary tooltip that shows with high
  priority only once". The tip is too short to say that a part already sent is transcribed and
  cleaned up even if the user cancels; the consent page and this ADR say it. A user still in the
  welcome wizard at launch never gets the tip.
- After a chunk gives up for good while the user is still speaking, the later chunks are still
  sent (and count toward usage) until the release, though they will not be pasted: nothing is
  shown until the release.
- A long dictation's chunks always carry the cleanup's variables, in agent mode too: the first is
  sent before the release, and Space can switch the mode back to dictation after it. Agent mode
  uses only the transcript.
- Each chunk is a request of its own and counts toward usage as one; an overlap's 15 s are
  transcribed twice.
- The cleanup sees one chunk at a time: a sentence cut at a forced cut is cleaned in two halves.
  The polish reads the whole text, if it can within 5 s: a light-tier model writes the text out
  again, so a long dictation (several minutes) may run out of time and keep its chunks' cleanups.
  It is one more completions request per long dictation, and up to 5 s more at the spinner.
- 10 minutes at 16 kHz is about 19 MB of samples kept in memory until the release.
- A chunk is cut only after 10 s of speech, so a pause cut is never shorter; a forced cut leaves the
  next chunk at least its overlap.
- The model's real limit is unmeasured past the 120 s cap: `chunkMaxDuration` stays under it.
- iOS does the same (`tabmail-ios` ADR-IOS-087), from the same rules and numbers.

### Amendment 2026-10-07: no cuts at pauses; a chunk is cut only at `chunkMaxDuration`

Owner, 2026-10-07: cutting at pauses barely sped up a long dictation's text, and it made the
dictation worse, since people pause between words and sentences and a chunk's cleanup sees only its
own half of the sentence around the cut. `chunkCutsAtPauses` (`config.ts`) is now false: every cut is
the forced one, at the quietest `chunkForcedCutWindow` near `chunkMaxDuration` (105 s), with the next
chunk overlapping it by `chunkOverlapSpeech`, joined on their shared words as above. A dictation
under 105 s is one upload. The pause rule's code, numbers and tests are kept, switched off, for a
later look (owner: "don't remove code because we might revisit this later"); its tests turn it on
through a config mock. Retries, the join, the polish and what is pasted are unchanged. iOS: the same
switch (ADR-IOS-087 amendment 2026-10-07).

- Tests: `chunker.test.ts` › "Chunker as shipped" (a dictation with pauses after 10 s of speech is
  not cut; a long one is cut only near the maximum length, each chunk overlapping the one before;
  random dictations covered), red with the switch on; the pause rule's own tests, and the
  controller's and recorder's long-dictation tests, run with it on.

**Amendment 2026-10-09 — what came in is pasted, and nothing is said of the end.** Owner, of "Couldn't
transcribe the end": *"instead of showing that message, paste directly whatever it has left"*. A
long dictation whose end was lost (a chunk giving up, above) pastes the chunks before it as any
dictation's text, and the pill goes back to rest: `partlyTranscribedMessage` and
`partlyNotPastedMessage` are gone. Not pasted, as the user switched apps (ADR-DESK-042), it gets the
usual note with that text. The loss still goes to the log (`log.error`). Unchanged: the chunks after
the first that gave up are not pasted (no hole in the text), the first chunk giving up fails the
dictation, and agent mode carries out nothing of a request whose end was lost.

- Tests: `controller.test.ts` › a long dictation (a chunk not in by the deadline, failing on every
  try, refused, or after an account switch: the chunks before it pasted and the pill at rest; not
  pasted, the usual note; the seeded fuzz).

**Amendment 2026-10-18 — the what's-new tip now tells of memory (ADR-DESK-061).** The one-time tip's
place is taken by `agentMemory` ("New: agent mode remembers / past requests, on this computer"),
first in line at the next dictation, shown once, and learned at launch by a user still in the welcome
wizard, as before. The long-dictations tip is retired: a user who never saw it is not shown it now.

