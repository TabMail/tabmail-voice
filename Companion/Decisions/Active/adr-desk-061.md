## ADR-DESK-061: Memory: agent-mode requests kept on this computer, searched by Thunderbird's helper

**Context:** Owner, 2026-10-17: port the agent's memory from Thunderbird (the reference) and iOS to
Voice, so agent mode can look back at earlier requests as Thunderbird's chat does with
`memory_search` and `memory_read`; Voice's own memory, not synced. Decisions (owner, 2026-10-17):
memory is per user of the computer, in the app's data folder, and is not cleared at sign-out or a
change of account; everything agent mode does is kept (Compose and Edit too: "most of the requests
for voice will be compose or edit"), plain dictation never; a size limit in Settings, 1 GB by
default (Thunderbird gets the same), the oldest exchanges removed first; and one codebase: Voice
does not copy Thunderbird's search helper (`tabmail-native-fts`) but builds it from its repository
at a pinned commit, telling it where its database, model and logs go, and never touching
Thunderbird's copy or its files.

**Decision:**
- **The helper.** `voice-memory` is `tabmail-native-fts` (its `fts_helper`), built by
  `scripts/memory-helper.mts` from `https://github.com/TabMail/tabmail-native-fts.git` at the one
  commit `native/memory/native-fts.json` pins: fetched clean into `native/memory/.build` each build,
  checked to be at that commit, built `--release --locked` (the helper's own Cargo.lock) with the
  Rust toolchain the app's core pins. Every platform's `build-native.mts` puts it in `dist/helpers`
  (on the universal Mac app both architectures joined by `lipo`), signed and notarized with the app.
  Voice keeps no copy of its source; a helper change is made and reviewed in its repository, and a
  move to it is a change of the pinned commit. That repository's ADR-NF-008 makes the helper take
  the caller's locations and a size limit.
- **Where it is kept.** `MemoryHelper` (`src/main/native/memoryHelper.ts`) starts `voice-memory` on
  first use, with `--log-level off`, and sends `init` with
  `profilePath <userData>/memory/database` and `modelDir <userData>/memory/models`; the helper makes
  those folders, the app makes none (a folder that can't be made fails `init`, and memory's requests
  fail without naming it). Once its model has loaded (`init` answers `hasEmbeddings`), it ends it
  after `memoryHelperIdleTimeout` unused (it holds a reader cache and the model); a helper whose model
  didn't load (offline at its first start) is kept until quit, so it doesn't try the download again
  at every start. It ends at quit either way. A helper that can't be spawned at all fails the
  request, as a failed start does. It speaks
  Thunderbird's native messaging (a 4-byte little-endian length, then JSON; replies by id), sends
  only `init` and the memory methods, never `hello` or the update requests (no self-move, no
  self-update: the app ships the build it runs), and registers no native-messaging host. Thunderbird's
  helper, its database, models and logs, and `~/.tabmail` are never named, so never touched (the
  helper's tests hash them before and after). The first start downloads the embedding model (about
  87 MB, from cdn.tabmail.ai, checked by its hash) into Voice's own model folder, before `init`
  answers, so memory's requests wait for that first download; if it fails, search is by keyword
  only, as on Thunderbird and iOS.
- **What the helper logs.** Nothing, in every build: `--log-level off` writes no log file anywhere
  and nothing to stderr. Its log would name what memory was asked (each search's query), and a
  helper outlives the debug switch and the account signed in, so a log level chosen when it starts
  would go on logging after either changed (*Amended 2026-10-18: it was `debug` while debug
  logging was on, decided at start*). Debugging memory loses the helper's own diagnostics; the app's
  debug log still has each request and its reply. What the helper still writes to stderr (a crash's
  message) goes to the debug log through `log.content` only. A helper's
  error reply can quote the query (SQLite's errors do), so it becomes a `MemoryError` whose
  `reason` goes to the model and whose logged description names only the request.
- **What is kept.** After each agent-mode request, one row shaped as Thunderbird's add-on writes it:
  `[USER]: <the request as transcribed>` then `[AGENT]: <the reply>`, or for a writing tool the text
  it wrote with where it went and the app (`Pasted at the cursor in <app>:`, `Replaced the selection
  in <app>:`), under session `voice_agent`, dated now. Never: plain dictation, the screen read, the
  selection being edited, tools' calls and results, audio. A request that delivered nothing keeps
  nothing. Keeping is best effort: nothing waits for it, and a failure is logged by type and
  request only.
  Agent mode needs consent and a sign-in, so nothing is kept without them.
- **The tools.** `memory_search` and `memory_read` run on this computer, in the agent loop with
  every request (Answer on or off: an Edit or a Compose may draw on an earlier one), with
  Thunderbird's argument handling and result text (`src/core/memory/tools.ts`); they only read, so
  they ask nothing, and the chat window says "Looking through past requests" while one runs. As
  Thunderbird's, a query the helper refuses (its full-text syntax can't take `re: invoice`, `50%`,
  `(x` or `x AND`) comes back as `memory search failed: <the helper's reason>`, so the model can
  rephrase it rather than repeat it; any other failure (no helper, a timeout) as `memory search
  failed`, naming nothing more; a read the helper refuses, `memory read failed: <reason>`. The
  backend's Voice loop carries their schemas and Thunderbird's memory rules; their results are
  model input like any tool's, under the backend's web-read guard. They replay the agent's own
  earlier replies and written text, so that guard gives a URL found in them no provenance (for every
  client): a link known only from memory is not opened. The backend change ships
  before, or with, the Voice loop's memory tools.
- **The size limit.** A Settings value (`memorySizeLimitChoices`: 100 MB to 5 GB; 1 GB by default),
  part of the key-down snapshot (ADR-DESK-017): each row is kept within the limit of its request's
  key-down, the helper removing the oldest exchanges first, measured as the pages its database uses.
  Choosing a smaller limit asks first, in place as Clear All does, whatever usage shows (it can be
  unread or out of date), then trims at once and says how many of the oldest went, and, if the
  helper ran out of time, that more go as new requests are kept. A larger limit applies at once. A
  limit the settings file can't keep is put back and nothing is trimmed ("That size limit couldn't be
  saved. Try again."), as an exclusion that can't be saved: a relaunch would bring back the saved
  one. Space freed is reused; the file keeps its size (no `VACUUM`, which could take unbounded time).
- **Settings › Memory** (`src/core/memory/page.ts`, a port of Thunderbird's Chat History tab, in
  Voice's style): a usage bar, "Memory used: X of <limit>", the limit, the requests newest first (at
  most `memoryListLimit`), a search, Remove on each, Reload (reads memory again and says "Memory
  reloaded." once read), and Clear All with a confirmation. A Remove shows as removing until its own
  removal answers. It reads
  nothing, and starts no helper, until the helper first ran (the database exists; the helper makes
  it at its first start, when agent mode is first chosen). Usage and the list
  are read apart: a search the helper refuses empties only the list ("Couldn't search for …. Try
  other words."), with usage and Clear All still there, as Thunderbird's tab shows no results.
  Clear All is always available, and always asks memory to clear, whether or not its database
  exists or usage can be read: it is the way to start memory afresh, and a clear cut short (the
  database file deleted, its write-ahead log, which holds the latest exchanges, not) is finished by
  the next.
- **Clear All** deletes memory's database folder (`memory/database/tabmail_fts`), after ending the
  helper and waiting for it to exit (ended outright after
  `memoryHelperExitTimeout`); requests made meanwhile wait, and the next starts a helper on an empty
  database. Not the helper's `memoryClear`: it deletes the files while its own reader connection
  holds them open, which Windows refuses (SQLite opens them without `FILE_SHARE_DELETE`), and it
  still answers ok. Settings says "Memory cleared." only once that is done; otherwise it says it
  couldn't be cleared.
- **Consent.** The consent page says requests are kept on this computer and can be removed
  (ADR-DESK-010, amended); users who consented before are told once by the what's-new tip
  (ADR-DESK-049, amended).

**Consequences:**
- Agent mode's requests and results are now written to disk, on this computer only, in the user's
  app-data folder; they stay until removed, cleared or trimmed by the limit, across sign-out and
  account changes. Root ADR-004 is about email content; Voice's memory is the user's own requests,
  kept locally as Thunderbird's chat memory is.
- A user with Thunderbird and Voice has two helpers and two copies of the model (one extra download
  of about 87 MB).
- The vector index frees its space 1,024 exchanges at a time (measured in the helper's repository:
  about 7.8 MB with the text, 7.8% of the smallest limit and 0.73% of the default), so a trim can
  remove up to that many more of the oldest exchanges than the text alone would need (owner
  decision pending).
- The build fetches from GitHub; the pinned commit must be on `TabMail/tabmail-native-fts`'s main
  branch.
- Tests: see `TESTS.md` (memory rows). The helper itself is tested in its repository.

> **Amended (owner, 2026-10-19): a search with no query lists the most recent.** The owner: *"What
> have we discussed thing should basically trigger a memory search with the most recent, like, 10
> things"*, and of the refusal: *"That empty query is a bug. It should not reject it."* `memory_search`
> refused a call without a query ("missing query"), as Thunderbird's and iOS's tools did, though the
> helper lists the newest exchanges for an empty one (in the dates asked, if any). It now passes it
> on: no query (left out, blank or not a string) lists the most recent exchanges, newest first, a page
> (`memorySearchPageSize`) at a time like any search. The backend's schema at this app's protocol
> version (ADR-DESK-064) no longer requires a query and says when to leave it out. Tests:
> `memory/tools.test.ts` (no query lists the newest first, paged, in the dates asked), red-verified
> against the refusal.
>
> **A day is the user's local day.** `from_date` and `to_date` given as a day alone (`YYYY-MM-DD`, the
> form `time_delta` answers "yesterday" in) are the whole of that day where the user is: a start from
> its local midnight, an end through its last millisecond, the next day's start less one (the helper's
> bounds are inclusive and keep milliseconds), however long daylight saving makes the day (where it
> skips midnight the day starts at 01:00 and the next at 00:00). JavaScript reads a bare day as UTC midnight, which made "yesterday" as start and end
> an empty window, and shifted every day by the user's offset. A time without an offset is local too;
> one with an offset is read as written. As `Arguments.localEnd` reads a day for the calendar and files
> tools. Tests: `memory/tools.test.ts` (a day west of UTC, east of it and in UTC, red-verified).

> **Amended (owner, 2026-10-20): a listing is fetched a few exchanges at a time.** The no-query
> listing asked the helper for every page's worth at once (`memorySearchPageSize` times
> `memorySearchPrefetchPages`, up to 2,000 exchanges), each exchange in full, in one reply. Voice's
> pipe carries that, but Thunderbird's native messaging caps one reply at 1 MiB, and the owner: *"even
> if they support going over 1 megabyte, I feel like it's probably a good idea to still do
> pagination."* The listing still shows `memorySearchPageSize` exchanges a page, and now asks the helper
> for `memoryListFetchRows` (5) at a time, as its pages are asked for: each request the newest no newer
> than the last one listed (the helper's `to` includes it, to the millisecond), less those already
> listed at that millisecond (by `memId`: the helper orders by date alone, so exchanges of one
> millisecond can come in any order), and one more, to know whether more follow. Until all are listed a
> page says more follow and gives no `totalPages` or `totalItems`, as Thunderbird's tool does. A
> request that fails is the tool's error, and the next call goes on from where the listing got to. A
> listing still ends at 2,000 exchanges (the same cap as a search): a far `page_index` lists at most
> that, in about 400 requests, never the whole memory; older exchanges are reached with dates. A
> search with a query is unchanged (its results are cut by relevance). The agent loop runs one tool
> call at a time, so no two calls list the same search at once. Tests: `memory/tools.test.ts`
> (mutation-verified).

> **Amended (owner, 2026-10-22, #245): a search fetches its 100 best matches.** *"100 everywhere,
> round numbers are good."* `memory_search` asked the helper for `memorySearchPageSize` times
> `memorySearchPrefetchPages` results (2,000), capped at `memorySearchFetchMax` (10,000). Nobody reads
> that many, and a hybrid search of 4 x 2,000 nearest vectors ran into sqlite-vec's largest `k`
> (4,096), which made every memory search keyword-only until the helper capped it
> (tabmail-native-fts#25). One setting, `memorySearchMaxResults` (100), replaces the two, as
> Thunderbird's tool: a search asks for its 100 best matches in one request and serves pages of 20
> from them, and past them the agent refines its query rather than paging deeper. A listing (no query)
> ends at 100 exchanges too, in 20 requests at most. The helper's 512-result cap is a safety limit, not
> the target size. The same rule: Thunderbird #150 and iOS #264. Tests: `memory/tools.test.ts` (a
> search of 130 matches gives 100 in five pages of 20; the request's limit; a listing's far page),
> red-verified against the previous settings.

> **Amended (2026-10-19): the helper is native-fts 0.11.8, and no helper carries the home folder.**
> The pin moves to the 0.11.8 commit (`04b19a3`), whose dependencies the security audit passes. A
> Rust build keeps its dependencies' source paths in the binary, and on the builder's computer they
> start at its home folder, which names its user: 0.2.4's Mac helpers carry it from the Rust core
> (8 to 23 paths each), and in the Swift link's debug map, which names each object file by its path
> in the checkout. `scripts/home-folder.mts` gives the Rust builds `--remap-path-prefix=<home>=~`
> (after any `RUSTFLAGS` already set) and refuses a built helper that still holds the home folder;
> `buildMemoryHelper` and the Mac build's Rust core use both. The Mac build strips the debug map from
> the Swift helpers it ships (`strip -S`, observed to keep the linker's signature valid; the build's own
> copies keep it, beside their debug symbols) and checks every helper it copies, as the memory
> helper's own release build does. Windows and Linux release builds run on CI
> runners, whose home folder names no one; their memory helper gets the same flags and check. Tests:
> `native/memoryHelperBuild.test.ts` and `native/macosBuild.test.ts` (the flag, kept beside earlier
> flags; the Swift helpers shipped without their debug map, thin and universal; a helper holding the
> home folder refused), red-verified against the previous build scripts.

