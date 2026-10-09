# Shared native core

The existing Swift and C++ helpers link this Rust static library. No new daemon or Electron addon is involved. Native adapters retain accessibility, audio, clipboard, credentials and OS lifecycle ownership.

## Build and test

Install Rust through rustup; `rust-toolchain.toml` pins the compiler and components. Run `cargo test --release --locked` and `cargo clippy --all-targets --locked -- -D warnings` in this directory. Release mode is the shipped profile used by the hostile-input timing gate.

The macOS build script and `scripts/swift-errors.sh` build the Rust target before SwiftPM, and `scripts/swift-errors.sh test` runs `cargo test --release --locked` before the Swift suites. For a direct SwiftPM invocation, first run `cargo build --release --locked --target aarch64-apple-darwin` here (or `x86_64-apple-darwin` on Intel), then run SwiftPM in `native/macos`. CMake builds and links the matching Rust target for Linux and Windows, and adds `voice-rust-core` to CTest. Cross-compilation requires the selected rustup target and native linker toolchain.

## Redaction contract

`../privacy/redactors.json` is embedded directly and read once into typed redactors (`privacy/definitions.rs`), each data for one of a few kinds; one scanner (`privacy/scan.rs`) applies them all to the text as read, in no order (the union of what they take is taken out). Native helpers do not interpret the definitions. Every scan is linear in the text, so there is no engine to fail; the hostile-text and continuation gates hold it to that.

`voice_core_redact_json` takes UTF-8 JSON arrays of lines containing adjacent fragments. Matching precedes fragment redistribution. Boundary mapping uses the existing UTF-16 contract; invalid encoding or boundaries refuse the operation. The ABI validates shape, bounds and version, catches panics with a payload-free hook, and returns an owned output buffer. The caller must free it exactly once with `voice_core_buffer_free`; a nonzero status never permits a raw-text fallback. Pointer validity and non-overlapping input/output memory are the native caller's responsibility, as documented in `include/voice_core.h`.

The Rust corpus also holds the former generator/schema checks, per-rule and case-flag mutations, source-fixture secrecy checks, and scalar/fragmented idempotence. Native tests still run the corpus through the linked ABI and retain handler-level privacy tests.

## Screen context

`voice_core_context_json` accepts already-permitted blocks, optionally with three caret fragments. It lays the read out once (each block's separator from the one before), redacts that one text last with `privacy::taken` (every rule's matches in the text as read, with no rule order), and shows only what survived of the parts the read shows, with one marker where shown text was taken out; the render adds markup and nothing else, preserves frames, and marks a redacted blank selection. The pieces of one line on screen (text and links the render puts on one line) are joined with a space where the screen has one and nothing where they abut; `admit` keeps one space at each edge of a piece that had any so the two can be told apart (ADR-DESK-007, 2026-10-07 and its night amendment). A block may carry `ends`, the boxes of its text's first line (or character) and of its last, as `[[x,y,width,height],[x,y,width,height]]`: two pieces meet where the first one's text ends and the next one's starts, since a piece that wraps has one frame over all its lines (#178). Rendering, line overlap, column separation and block prefixes have one Rust implementation. The same API normalizes complete text and admits whole bounded source fragments against one shared UTF-8 budget; canonical-equivalent duplicate detection precedes admission. Foundation whitespace semantics, including U+200B, are used across platforms. The former configurable `join` operation has been removed. Pinned `unicode-segmentation` supplies UAX #29 boundaries. Native code controls provider traversal and privacy/visibility preflight. `../context/context-cases.json` runs through the Rust and native ABI suites.

The same entry point joins a rich editor's text and walks its blocks (ADR-DESK-007, ADR-DESK-054). `{"hypertext":{"elements":[…]}}` takes each element as the OS gives it (its text, caret, selection, whether it is a block, and its links: an offset at U+FFFC and the child element there) and joins them in order, placing the caret and selection and starting each block's line with a line break, as the screen shows it. `{"blockStarts":…}` is the Mac and Windows walk of a Chromium editor's blocks near the selection, as a step protocol (`src/blocks.rs`): `start` with an element budget, then the helper answers each ask (`children` of an element, or `placed` facts for one: whether it is a block, and only what the ask's phase needs, each a comparison the OS makes across processes: while halving, whether it ends before the window; while scanning, whether it starts past it or within it) and the core says which start a line and when the walk ends; `{"endsLine":{…}}` says which side of a block boundary the caret is on.

`voice_core_screen_json` builds the screen read's whole reply (ADR-DESK-054). A helper sends what its walk found (app, window title, page host, focused role, the blocks and the three caret fragments, or a terminal's viewport request), the read's exclusion lists, node count, time and stop reason. The core checks the page host against the excluded sites once more (`{"hidden":true}` when excluded), redacts the title, finalizes the blocks and caret (or projects the viewport), and adds `selectionRedacted`, `renderedText`, a counts-only `summary` and the debug log file's `logDescription`. `../context/screen-cases.json` runs through the Rust and native ABI suites.

`voice_core_request_json` decides the request rules every helper shares (ADR-DESK-054). `{"field":{"maxLength":n}}` checks a `focusedFieldValue` bound (1 to 20,000 UTF-16 units); with `"text"` (the field's text as read, or null) it gives the reply, `{"value":null}` for none or one longer than the bound in UTF-16 units, else the text redacted. `{"insert":{"text":t}}` checks a paste's text (not empty, at most 512 KiB, no NUL); with `"deadline"` and `"now"` (Unix milliseconds) it also checks the deadline is later than now and at most 5 s ahead, and gives the `wait`. `{"microphoneStart":{"session":s,"sampleRate":r}}` and `{"microphoneStop":{"session":s}}` check a microphone request: a session that is a whole number from 1 and, for a start, a rate in whole hertz from 8,000 to 96,000. Native code keeps how far a field is read and its own encoding checks. `../context/request-cases.json` runs through the Rust and native ABI suites.

`voice_core_viewport_json` with `{"surface":{…}}` builds one terminal surface for a helper that reads a terminal as one document (macOS, Linux; ADR-DESK-054). The helper sends the clip, its offset unit, the document's length, the visible spans and the text read from each, the byte budget left, the selections (null when unreadable) and the caret (null when there is none; its offset and where it is drawn, the drawing null when unconfirmed). The core gives back the surface's runs (connected where spans meet), its selection (complete only when every selection is wholly inside the visible spans; withheld when it does not fit the text) and the caret (`exact` when it is in a span and its leading edge is drawn inside the clip, edges included; `outsideViewport` otherwise; `unavailable` with none), ready for the viewport projection. It refuses text over the budget in UTF-8 bytes; a helper reads at most as many units as the budget has bytes, since a unit is at least one byte. Provider quirks stay native (iTerm2's insertion line, VTE's carets at the text's ends, GTK4's missing bounded ranges). Windows reads surfaces through UI Automation endpoints and keeps its own. `{"start":true}`, `{"state","next"}`, `{"state","take","focused"}` and `{"state","finish"}` gather a window's surfaces into one viewport on every platform (how many surfaces and bytes, and whether it is complete), the helper carrying the state unchanged between calls; `{"plan":{"count","spans","bytes"}}` says whether planned spans may be read (`src/viewport/collect.rs`). `../context/surface-cases.json` runs through the Rust and native ABI suites.

`voice_core_walk_json` decides the screen walk's steps (ADR-DESK-054). `{"node":{…}}` takes what the OS says about one element (`role`, one of `page`, `text`, `heading`, `link`, `row`, `listItem`, `field`, `control`, `toolbar`, `chrome`, `other`; `focus` `self` or `path`; `part` inside a heading, link or row; the flags `inPage`, `password`, `pageExcluded`, `focusedField`, `selection`, `hidden`; `frame`, `window` and the display `scale`, from which the core takes how thin a box hides its text) and gives the `action`: `refuse`, `skip`, `caret`, `descend`, `text`, `field`, `semantic` (with `kind`) or `caption` (with `shown`). `{"look":{"read":…,"found":…}}` says whether a part read whole is read, refuses the window or gives the marker. `{"census":{…}}` is one step of a look inside an element (a `start` step at the element itself, then one per element inside, with the node budget): for an excluded page, or, with `protect`, also for a password element anywhere in it, the element included, which refuses the look; a protected look counts the element itself against the budget, the other does not. `{"stop":{…}}` names why a walk stops, and `{"limits":true}` gives its budgets (5,000 elements, 1.5 s, focus depth 200). `{"shown":{"frame","window","scale","hidden"}}` applies the same box rule to an element read outside the walk (a terminal's surface on Windows). The C++ helpers' wrapper is `../context/walk.h`, the Swift one `SharedWalk`. `../context/walk-cases.json` runs through the Rust and native ABI suites.

### Common semantic acquisition

`voice_core_semantic_new/offer/finish/free` implement one streaming policy. Rows request approved descendants first and request a root label only after a complete, empty traversal. Headings and links request an approved root label first; a normalized blank root requests descendants. Interrupted traversal retains only the approved prefix and never requests a row fallback. Native code must obey the returned acquisition decision and continue to apply privacy checks before obtaining each value.

The core owns whitespace trimming, canonical adjacent duplicate detection, separators, extended-grapheme counting and budget stops. There are no OS/unit/separator/overflow options. A semantic block stops acquisition at 20,000 graphemes or 256 KiB of joined UTF-8 text; each incoming fragment has a 256 KiB acquisition bound. The final accepted fragment stays whole for combined-screen redaction, so the joined source may exceed the presentation bound by at most one bounded fragment. Invalid UTF-8, invalid protocol events and oversized fragments refuse the operation, poison the owner and cannot become an empty successful result. Wrappers own handles exclusively and release them with scoped cleanup.

**Finish returns private source, not publishable context.** This distinction is required: clipping through a synthetic access key before redaction leaves an unmatched prefix. Shared presentation limits must run after combined redaction. All three production readers now use the Swift/C++ wrappers and this common acquisition contract. `../context/semantic-cases.json` runs the same traces through every wrapper. Shared admission reserves caret source exactly once and stops subsequent acquisition after the final whole fragment crosses 256 KiB. Combined redaction precedes shared presentation clipping: ordinary blocks share the remaining UTF-8 allowance, semantic blocks additionally obey the grapheme limit, and caret presentation retains the full selected text with up to 2,000 nearest graphemes on each side. Oversized caret source is refused; rendered layout syntax can expand beyond the source-byte allowance. Field, caret, static text and name adapters on all three platforms now use shared source policy. Native provider acceptance and packaged validation are tracked separately.

### Incomplete source windows

The context API accepts `window: {text, startKnown, endKnown}` for at most 256 KiB of UTF-8 recognition source. Both edge facts are required. Complete windows retain every byte. At an open edge, Rust retains only the middle closed by actual source punctuation (`. , ; ! ?`) followed by Unicode whitespace; whitespace alone cannot terminate the canonical named-value and PEM continuation patterns. The closing punctuation remains in source so later composition does not erase that boundary. A window without a closed middle is unavailable. Returned offsets are UTF-8 byte offsets into the original window.

`sourceText` is private input for subsequent combined redaction, not a publishable result. The response also reports unknown/withheld edges and unavailable content. Native adapters must map a selection against the retained range and report an incomplete selection as unavailable, never as a shorter selection. The caret operation below supplies this mapping. Adapter migration is tracked separately; the API alone does not make a truncated native result complete.

Tests insert all candidate delimiters at every scalar cut of a positive witness for each canonical rule and reject matches crossing the restart boundary. Changes to the redactors require reconsidering this boundary contract as well as the shared redaction corpus. Native ABI fixtures cover complete Unicode source, open edges, and unavailable windows.

## Caret recognition source and presentation

`limits` exposes `sourceWindowBytes` (256 KiB per side), `selectionSourceBytes` (screen bytes minus the six bytes for selection markers), and `caretSourceBytes` (the selection allowance plus both side allowances). `read_caret` validates each component independently; a selection exceeding its allowance is refused intact. `reserveCaret` computes the prospective presented caret size on a private copy. It does not truncate the caller's recognition source. Combined redaction receives the full bounded sides before the existing nearest-2,000-grapheme presentation step. The aggregate recognition allowance includes both source-only sides separately from ordinary screen source admission.

Native adapters use these shared allowances. They must still establish source-edge facts; a truncated provider result cannot become complete merely because it fits an allowance.

`caretWindow: {parts: [before, selected, after], startKnown, endKnown, caretStarts?}` maps the same shared recognition boundaries across contiguous caret partitions. It returns private source parts and `selectionUnavailable`. If an open edge intersects a nonempty selection, all caret source is withheld and the selection becomes the refusal marker; retaining adjacent text after replacing only a selection could erase a secret prefix needed to redact that adjacent text. If an empty caret itself lies outside the retained range, all caret context is withheld so distant safe source is not misrepresented as immediately adjacent text. Adapters must carry this flag through finalization to disable Edit. Other approved screen blocks remain usable. `caretStarts: {paragraph, line, lineText}` says what starts at the caret, as the provider lays the text out (`lineText`: the line's first bytes, null when it holds more than `limits.caretLineBytes`); when the caret starts a paragraph, or a line holding only a break, and the before part ends in no break, the core adds the one the provider left out, within the before part's budget (ADR-DESK-007, 2026-10-06). Without it no break is added. `paragraphStarts` (byte offsets into the parts joined, ascending, never 0) says where the provider starts each paragraph; the core puts back the line break before each start the text has none before, within each part's budget (a side at its limit gives up its far end and its edge); the text is then redacted as it reads, with those breaks (ADR-DESK-007, 2026-10-07). `caretEndsLine` (default false) says the selection starts at the end of the line above a paragraph that starts at the same offset (the text gives both places one), so that break follows the caret instead of preceding it. Adapters report starts within `limits.paragraphStartUnits` of the selection. `hypertext: {parts}` joins a rich editor's parts read in order (each element's own `text`, and the marks `blockStart`, `blockEnd`, `caret`, `selectionStart`, `selectionEnd`) into its text, with the caret and selection in Unicode scalars; a block starts a line of its own, and a selection ending after one holds its break. A helper reads at most `limits.caretSourceElements` elements and `caretSourceBytes` bytes of a rich editor; past either, or when the core refuses the join, the rich text is not read.

Linux focused caret acquisition now uses the shared Rust source planner and bounded 4,096-character AT-SPI requests, preserving complete selections rather than a 20,000-character prefix/refusal policy. It rechecks character count, selection endpoints/count, caret offset and focused state after acquisition. AT-SPI character offsets and reads stay native; Rust owns range planning, byte accounting, assembly, incomplete-edge handling and presentation. Linux terminal selections also use the collector with the selected interval as the complete source domain, recheck selection metadata, and propagate explicit refusal. Non-focused fields also use the shared field planner and source projection described below. Provider state can change between rechecks; these are observable consistency checks, not an atomic snapshot guarantee.

macOS focused caret acquisition uses the same shared limits through bounded UTF-16 ranges. Plain fields use character count, selection and `AXStringForRange`; marker-based editors resolve the field and selection endpoints, retain the provider's document-relative origin, and verify every generated marker's index before requesting text. Native chunks retain surrogate pairs across boundaries. Short ranges, changed endpoints, lost focus and deadline expiry refuse the caret; the unavailable-selection flag disables Edit after ordinary redaction. These adapters require actual-application validation, and macOS visible-field/terminal acquisition still needs migration. Snapshot rechecks cannot detect all same-length or ABA changes and do not provide an atomic snapshot.

### Shared native-offset acquisition

`voice_core_source_utf16_new` and `voice_core_source_scalar_new` construct the same collector with the provider’s native offset unit. `voice_core_source_next/finish/free` share chunk planning, assembly, surrogate-boundary handling, byte accounting and complete-selection refusal. UTF-16 providers use `voice_core_source_utf16_offer`; scalar-offset providers supply valid UTF-8 through `voice_core_source_utf8_offer`. Encoding mismatches poison the handle; offset representation never selects a different policy. `next` requests a bounded native span; the adapter obtains that span without decoding or clipping it and offers the code units. Short, oversized or malformed input refuses the operation; invalid offers poison the exclusive handle. A zero-length next request means acquisition is complete. Finish returns the existing private caret-window JSON and still requires combined redaction. A caret collector also takes, once before finishing, what starts at the caret (`voice_core_source_caret_starts`, the caret window's `caretStarts` JSON, at most `CARET_STARTS_BYTES`): the Mac measures it in a Chromium field's text markers, while Windows measures it and calls `caretWindow` directly. It also takes, once, where the provider starts paragraphs near the caret (`voice_core_source_paragraph_starts`, ascending native offsets, at most `PARAGRAPH_STARTS`, and whether the caret ends the line above one at its offset), which finish passes to `caretWindow` as `paragraphStarts` and `caretEndsLine`. A refusal poisons the handle. Handles and returned buffers have separate scoped ownership.

macOS plain-range and indexed-marker readers use this collector through a thin Swift transport; Linux AT-SPI uses the same collector through the scalar C++ transport. Windows IA2 uses the C++ transport while preserving its provider snapshot, privacy and focus checks; UIA uses the same source budgets and shared caret-window mapping, with bounded native range reads because UIA endpoints are opaque and Character movement can promote to larger units. It checks document boundaries, selection endpoints and selected content before returning private source. Page selections use that same selection allowance, check against the privacy-approved range before and after acquisition, and refuse oversized or changed results intact without acquiring adjacent text. Win32 Edit also uses the shared UTF-16 collector. Because standard Edit exposes whole-text transfer rather than arbitrary ranges, it bounds the UTF-16 transfer length by the shared aggregate source allowance before allocating, then feeds bounded chunks from that snapshot to Rust. Full DWORD selection endpoints avoid the packed-message 65,535-character limit. Changed length, selection, text or protection state refuses the result. Larger fields require the range-capable accessibility providers; this fallback does not claim arbitrary-size field support. Native adapters retain actual provider access, character-offset conversion, deadlines, privacy preflight and identity checks. No platform can select a different collection budget.

## Exclusion policy

`voice_core_policy_json` requires `excludedAppIDs` and `excludedHosts` arrays, even for a validation-only request. Optional `app`, `host`, and `page` queries return exclusion decisions. `page` is one of `unknown` (refuse), `noHost` (allow), or `host` (requires a host string). Native adapters validate the policy before any provider metadata or text access, and refuse on core failure. Individual strings are bounded to 32 KiB and cannot contain NUL. Unknown or invalid UTF-8 input is refused by the ABI.

Comparison uses [Unicode canonical caseless matching](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/) (NFD, full case fold, NFD), preserving both Linux's full case folding and Swift's canonical-equivalent String comparison. The pure Rust `icu_casemap` 2.3.0 and `unicode-normalization` 0.1.25 crates supply Unicode data; neither calls native ICU or performs regex matching. Their licenses are Unicode-3.0 and MIT/Apache-2.0 respectively. The single regex engine remains fancy-regex. Hosts strip exactly one trailing dot and match whole hosts or dot-delimited subdomains; app identifiers match whole. `../privacy/policy-cases.json` records Unicode, validation and unknown-page cases alongside the existing host corpus. Host matching also recognizes canonical IDNA and numeric aliases, computed before full case folding; original comparisons remain supported. App-identity and address acquisition remain native.

## Address classification

`voice_core_address_json` accepts `{address: string | null}` and returns `{kind, host}`. Null is unavailable/unknown, empty is explicitly absent/noHost. Present addresses use the pinned WHATWG `url` 2.5.8 parser. Syntax recovery is refused except embedded credentials; controls, invalid types and addresses beyond 32 KiB cannot authorize reading. HTTP(S) returns canonical domain/IP text, other valid schemes return the scheme token. Provider absence/error evidence and native string conversion remain in the adapters. `../privacy/address-cases.json` exercises the same classification through all three native adapters.

## Gesture state

`voice_core_gesture_modifier`, `voice_core_gesture_key`, `voice_core_gesture_owns` and `voice_core_gesture_ended` operate on a caller-owned fixed-size state value. They allocate nothing, retain no pointers and return scalar actions. Native monitors normalize key identity and timestamps, maintain physical key-up ownership, and own event/portal lifecycles. Swift/C++ traces use `../hotkey/gesture-cases.json`.

## Explicit document text

`voice_core_redact_text_json` accepts `{text: string, before?: string, after?: string}` with at most 128 KiB of UTF-8 in all three and returns `{text: string}` after the canonical Rust engine. A reader of part of a document passes the text around it as `before` and `after`; omitted, the text is complete. The three are redacted as one text and only the middle is returned, so a secret continuing past an edge is recognized whole, and a match crossing an edge takes all of its characters on either side; where it took text from the start of the middle, one marker stands there. Invalid types refuse the request. All three native services expose it as `redactText`. Invalid input and core errors refuse the operation; it never returns the unfiltered input on failure. File authorization is the caller's responsibility and is independent of screen exclusions.

`src/main/native/textRedactor.ts` supplies the app-side boundary for the PDF reader. It refuses unavailable/restarting helpers instead of queuing private text, bounds replies, sanitizes error details and discards results after cancellation. This boundary alone does not implement or authorize PDF reads.

## Timing validation

Run the macOS release suite with `swift test -c release --no-parallel` from `native/macos` when evaluating wall-clock redaction limits. Swift Testing otherwise runs unrelated corpus, large-input and provider tests concurrently; their CPU contention can obscure the engine's timing. Keep the release hostile-text limit at two seconds. An isolated timing pass does not replace the full functional suite. This does not disable concurrency exercised inside an individual test.


## Field source acquisition

`voice_core_field_utf16_new` and `voice_core_field_scalar_new` reuse the same source planner with a field interval `[start,end)` inside a document of `count` native units. They never request adjacent source. Fields use the common source-window byte allowance, independently of the complete-selection allowance. `finish` returns private JSON `{text,complete}`: `complete` says whether the requested interval was fully acquired, not whether the interval covers the whole document. An incomplete whole-field attempt allows a native visible-range fallback. Short or malformed provider responses still poison the owner.

Rust derives document-edge facts from the supplied interval, treats an acquisition cutoff as an unknown end, and withholds ambiguous boundary portions through the common recognition-window policy. A complete visible interval may consequently return less text than was acquired. All returned text must still pass combined screen redaction. Mac top-level ordinary fields now use the shared field policy and source projection described below. Fields inside semantic aggregation and the ordinary Windows/Linux readers also use shared source projection. Provider visibility discovery and snapshot validation remain native.


`voice_core_visible_field_utf16_new` / `voice_core_visible_field_scalar_new` acquire bounded adjacent recognition source around a visible target. They return `{parts:[before,visible,after],complete}`. If the target exceeds its allowance, the collector never joins text from beyond the omitted tail. Unknown source edges use the common recognition-window rule before mapping back into the parts. `complete` describes target acquisition; conservative boundary withholding can still remove visible text.

`fieldPlan` chooses whether a trusted native count permits a whole-field probe and whether complete text fits the shared whole-field grapheme policy. `admitField` accounts for all private bytes without changing source whitespace. A context field block carries matching `text` and `source:[before,text,after]`; finalization redacts those contiguous parts together with the screen, then keeps only the visible part and discards source metadata. Rendering a projected field also finalizes it; a caret block requires its real caret parts. Each field part is at most the source-window allowance, and aggregate block recognition input has a finite shared cap. Offscreen recognition text never enters the rendered field.

The Mac adapter prefers supported numeric ranges and visible-range metadata, retains the line-geometry fallback, and uses one native whole-value snapshot for value-only providers. AX has no length-limited whole-value operation, so this preserves capability without claiming a pre-receipt allocation cap. Downstream copies and matching remain bounded. Numeric and visibility rechecks detect observed changes but are not atomic-snapshot guarantees. The line-geometry fallback assumes monotonic line tops and bounds its target at the window bottom; provider verification remains required.


Indexed field visibility uses the context `fieldRanges` request with `{count, ranges}`.
The core accepts at most 64 pairs, validates offsets, sorts and merges touching or
overlapping spans, and preserves gaps. Native adapters retain their native offset
units and acquire source only after privacy approval. Linux top-level fields use this contract and `fieldPlan`. Windows top-level fields
use `fieldPlan`, `opaqueProbes`, and `fieldWindow` over native UIA ranges. Semantic
aggregation retains projected source through the shared semantic collector. AT-SPI GetBoundedRanges is content-bearing and does not bound
provider/IPC allocation; the native adapter discards and releases its content,
then uses exact scalar chunks for the bounded shared collector.

Opaque range transports use `opaqueProbes: true` for descending movement probe sizes
and `fieldWindow: {parts, startKnown, endKnown}` to apply the same source projection
as the indexed collector. Native movement counts are not interpreted as UTF-16
positions. Native adapters validate actual returned text and endpoint containment;
all private parts still require combined redaction before publication.


Semantic projected source uses `voice_core_semantic_offer_projected` with JSON
`[privateBefore, visible, privateAfter]`, and `voice_core_semantic_finish_projected`
returns `{text, runs}`. Each run is `[text, visible]`; normalization whitespace
remains private source, and only visible runs contribute to display text. Equal
visible strings with different private context are not duplicates. Legacy string
finish refuses once a projected fragment is accepted. `admitSemantic` accepts a
semantic block containing `kind`, `text`, and `runs`, and charges every source byte.
Final context redaction removes all run metadata. Native row/heading/link callers on all three platforms now retain these runs for
embedded fields. Static text and labels also use the bounded block source collector; native APIs that return whole strings cannot promise a pre-receipt allocation ceiling.

## Terminal viewport

Native AX, UIA and AT-SPI adapters acquire the displayed terminal and pass it to
shared Rust. No live terminal path executes tmux or discovers a pane/PTY.
Tmux/process metadata parsers and cell-column projection are removed. Exact
caret positions must come from the native provider's text offsets; matching
pane text or process activity cannot authorize acquisition.

`voice_core_viewport_json` consumes only already-authorized visible source. Native
adapters must prove privacy, focus identity, viewport clipping, native offset
mapping and capture stability before calling it. It never acquires hidden text.
The request contains:

- `complete`: whether the native capture covered the visible viewport;
- `focusedSurface`: capture-local numeric surface identity, or null;
- `caret`: `{status: "exact", surface, run, offset}` using run-local UTF-16
  insertion offsets, or a status of `outsideViewport`, `unavailable`, `withheld`;
- `surfaces`: each has numeric `id`, finite `[x,y,width,height]` `frame`, `runs`, and
  `selection: {complete, ranges: [{run,start,end}]}`. Selection ranges are ordered,
  nonoverlapping, and independent of the caret;
- each run has numeric `id`, `text`, `connected`, `startKnown`, `endKnown`.
  `connected` means source-contiguous with the preceding run, with no inserted
  character (an actual newline must be in the text). The first run is not connected.
  `startKnown` and `endKnown` remain validated boolean source metadata. Native
  viewport adapters set both false. They do not trigger visible-text clipping:
  the visible-screen contract redacts recognizable secrets in captured text,
  while a fragment cut at a capture edge may not be recognizable. No hidden
  adjacent text is acquired to extend recognition.

Limits are 64 surfaces, 1,024 total runs, and the shared semantic source byte
limit across all run text. Oversized or invalid requests refuse instead of silently
truncating. Native collectors must enforce these bounds while acquiring text.
Runs separated by a hidden gap are never coalesced or read through that gap.

A NUL in run text is a cell with no character of its own (iTerm2 writes one for
an unwritten cell and for the right half of a double-width character). Before
redaction, a NUL right after a non-ASCII character is dropped as its right half
(iTerm2's widths depend on its settings; ASCII is never double width), and any
other NUL reads as a space. Dropping can only join text, so a right half never
splits a secret away from redaction; the accepted cost (owner, 2026-10-05) is that
a single blank cell right after a non-ASCII character reads as nothing. Request
caret and selection offsets count the native text, NULs included; the result's
offsets count the cleaned text.

The box around a terminal's cursor (`src/terminal_box.rs`) is cut from this
redacted result by the column on screen: pinned `unicode-width` gives each
grapheme its width (two for CJK and emoji), so the borders of a row holding one
line up with the cursor's; the cursor's column comes from the same graphemes.

The result preserves surface/run identity and whitespace, returns only redacted
text, and gives `renderedText`, per-run `renderedOffset`, exact caret
`renderedOffset` when available, and per-selection `renderedStart`/`renderedEnd`.
All offsets are UTF-16; literal marker glyphs remain ordinary text. Layout labels
are inserted after redaction. `complete` records native acquisition omissions;
redaction replacements themselves do not mean acquisition was incomplete.
A caret inside a redaction match is withheld.
The anchor redactor conservatively withholds even retained prefixes within a match.

`selectedText` is actionable only when `selectionComplete` is true for the focused
surface. Hidden, withheld, redacted or disjoint selections keep Edit unavailable;
retained visible intersections remain annotations where exact boundaries survive.
Refused selections return the existing `[redacted]` marker and false
`selectionComplete`, preventing a writing consumer from mistaking refusal for an
empty selection and choosing Compose. The native helper propagates that refusal
through its existing selection guard. An incomplete capture that could not
establish a focused surface also refuses selection, rather than representing it
as an empty, complete selection and accidentally enabling Compose.

The TS cleanup consumer accepts optional `ScreenContext.terminalViewport` and uses
its exact typed position. An explicit unavailable/outside/withheld state never
falls back to marker search or appending a caret. Native terminal routes do not
use generic caret/field acquisition; all three routes emit the typed viewport.
Collector coverage, actual installed-provider evidence and review repairs remain
required before claiming complete cross-platform capability.

Current terminal provider evidence:

| Provider | Installed-helper checks | Remaining qualification |
|---|---|---|
| macOS AX | Authorized cross-process AX fixtures exercise the native dispatcher, visible-only clipping, exact caret and shared projection, including expensive line-metadata providers; native tests cover capture invalidation | A real iTerm context timeout exposed a regression; the index-based acquisition fix passes isolated reproductions, while final real-app acceptance remains required |
| Windows Terminal UIA | ASCII/Unicode exact caret, visible blank rows, hidden scrollback exclusion, duplicate split panes, complete explicit selection and focus returning to the left pane | A non-collapsed TextPattern selection does not establish an independent caret, so it returns unavailable; ancestor-clipped aggregate ranges remain refused |
| GNOME VTE / AT-SPI | Duplicate split panes, exact Unicode caret, explicit selection with independently exact caret, pane focus changes, hidden-pane and old-history exclusion | Tested with VTE 0.84 in an isolated GNOME session and the installed caret extension; other terminal providers and concurrent focus races need their own evidence |

These checks exercise the installed native helpers. They do not by themselves
establish the complete installed Electron interaction or every terminal provider.

For AT-SPI, the viewport request may specify `offsetUnit: "scalar"`; the core
validates and converts run-local caret and selection offsets to UTF-16. Omission
or `"utf16"` retains the AX/UIA convention. Output offsets are always UTF-16.
`{limits:true}` returns the common `bytes`, `runs`, and `surfaces` acquisition
limits without processing text.

Run `python3 scripts/macos/test-ownership.py` from `apps/desktop` as a separate macOS ownership check. It builds its Debug helper inputs itself. It is intentionally not a Swift test post-hook: coverage and release test configurations must retain SwiftPM’s own linking and exit status.
