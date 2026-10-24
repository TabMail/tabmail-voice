## ADR-DESK-064: The app sends a protocol version, and shares Thunderbird's and iOS's prompts and tools

**Context:** Owner, 2026-10-19: Voice kept its own copies of prompts and tools that Thunderbird and
iOS have too, because the backend picks them by the client's version and this app's version line
(0.x) is not theirs (1.x). *"We could also introduce the protocol number pretty much similar to the
other platforms ... and that could allow us to use their platform as a shared one instead of having
an identical copy. We should do that ... because we already sent which tools are available and
that's programmatically disabled on the backend, it should be fine."* In 0.3.0 (owner's choice).

**Decision:**
- Every backend request carries `X-Client-Protocol: <config.clientProtocol>` (`requestHeaders`) beside
  `X-Client-Version`, the app's own version, which stays what users see and what reports carry. The
  backend picks this app's prompts and tools at the protocol version (backend ADR-017 amendment,
  "the protocol version"); a build without it (every one before 0.3.0) is read as before.
- `config.clientProtocol` is `1.9.3` from 0.3.0: the version on Thunderbird's and iOS's line whose
  common prompts and tools this app supports. The backend has, at it, the agent loop prompt with the
  memory tools and `change_setting`, the common `memory_search` that takes no query, and the common
  `memory_read`; this app's own tools (calendar, web, contacts, files, notes and the rest) keep their
  own schemas whatever the number.
- Raising it is a step taken with the backend: every common prompt and tool up to the new number
  then reaches the app, offered only as the backend's `allowed_tools` for Voice and this app's
  `available_tools` (`loopTools`) both list it, so a common tool the app does not run is never offered.

**Consequences:**
- A prompt or tool this app shares with Thunderbird and iOS is one file on the backend, not a copy.
- A backend change meant for a newer Voice is versioned at the protocol version that first has it,
  not at the app's version.
- Tests: `backend/completions.test.ts` and `backend/transcription.test.ts` (the header on every
  request, at 1.9.3).

**Amendment 2026-10-24 (owner): the protocol is 1.10.0 from 0.4.0.** Owner: *"the new search and all
with bugfixes will be 1.10"*, with every client's number aligned. `config.clientProtocol` is
`1.10.0`, the number Thunderbird (its add-on version) and iOS (`TABMAIL_PROTOCOL_VERSION`) report from
their 1.10.0 releases. The backend's new common file at 1.10.0 is `email_search`, which this app does
not list in `loopTools`, so it is never offered here; every prompt and tool this app uses resolves as
it did at 1.9.3. Tests: the same two, at 1.10.0.
