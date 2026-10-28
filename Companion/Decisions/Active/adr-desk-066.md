## ADR-DESK-066: Device Sync of the knowledge base and writing style with Thunderbird and iOS

**Context:** Owner, 2026-10-17: Voice joins Device Sync (root ADR-021), the relay Thunderbird and iOS
already sync through, for the knowledge base and the writing style (ADR-DESK-063). Owner-critical
rule: Voice must never wipe another device's knowledge base or writing style. The relay forwards each
message to the user's other connected devices and keeps nothing. Thunderbird and iOS merge a text
they receive by five steps (an epoch-zero time skipped; a time not newer than the last text received
skipped; with no text received yet, the newer time wins whole; with no edit since the last text
received, the incoming one is taken; otherwise a three-way bullet merge with the last text received
as the ancestor), and remember what they received, never their merge, as the next ancestor. They
send nothing in answer to a text, and an edit goes out 500 ms after the last one.

**Decision:**
- **What is synced.** Only `kb` and `composition`, each with its `<field>_updated_at`. Every other
  field of the relay (action rules, templates, reminders, the task cache, the action thresholds, the
  dictionary) is Thunderbird's and iOS's and is ignored. Opt Out of AI (`optsOutOfAI`) and the
  Device Sync switch are this computer's and never sent. `ai_cache_probe` is answered at once with an
  empty `ai_cache_response` under the same `probeId`.
- **Where it lives.** The engine is `src/core/sync/deviceSync.ts` (`DeviceSync`), free of Node and
  Electron; the times are `src/core/sync/time.ts`; the store's sync state (each field's text, time,
  the last text received and its time) is `UserPrompts.syncState` / `applySync`. The transport is
  `src/main/deviceSyncSocket.ts`, Node's own WebSocket; the main process wires it
  (`src/main/index.ts`).
- **Merged as Thunderbird and iOS merge, with these rules more,** each found by the seeded fuzz
  against a peer ported from Thunderbird's rules, the debounce included
  (`test/core/sync/deviceSync.fuzz.test.ts`), as the order in which it lost a bullet or never
  settled:
  - A text never synced here (none yet, or after a reset) is sent at epoch zero, which no device
    takes over its own, and the first text another device sends is merged three ways with the
    default as the ancestor (taken as sent when the bullets are the same), so the bullets of both
    stay.
  - Each synced text sent goes after its merge ancestor, the last text another device sent, in a
    message of its own per field at `ancestorTime` (one millisecond after epoch zero). A device that
    never synced would take a newer text whole and lose an edit still waiting in its 500 ms delay;
    with the ancestor first it merges instead. Every device that has synced holds a later ancestor
    and skips it; one only at its defaults takes it, then the text. One message per field: together
    two texts that each fit could be over the relay's size. Voice ignores a text at `ancestorTime`.
  - A text received with the time of the last one but other content is merged, not skipped: two
    devices can edit in the same millisecond.
  - When a merge leaves Voice holding other bullets than the device that sent, the merge is sent
    back at a new time, once for each pair of texts (received, merged) until the next five-minute
    probe or the end of the connection.
  - After sending its edits, or a merge back, Voice asks for the texts again: what comes back is the
    ancestor the next merge needs, so a bullet another device removes afterwards is removed here too,
    and isn't put back by the next merge.
  - No acknowledgement and no echo of a text under the time it came with: both had another device
    take an older text over a newer one and lose a bullet, and the acknowledgement crossing a reply
    kept two devices sending to each other without end.
- **Never wipes a peer.** A reset or a factory reset makes the texts "never synced" again (epoch
  zero, no ancestor): Voice takes the other devices' texts back, merged with its defaults, and sends
  nothing that removes one of their bullets. Another account signing in resets the texts, their
  history and the sync state to the defaults (`UserPrompts.claim`); memory stays.
- **When it runs.** For the account signed in, from a texts file that could be read, while
  `AppSettings.deviceSyncAllowed`: the settings file read (the switch is in it), the user's consent
  given, and Settings › Personalization's "Sync with my other devices" on (`syncsDevices`, on by
  default). Opt Out of AI doesn't stop it: nothing goes to a model. The relay is
  `wss://sync.tabmail.ai/ws`, `wss://sync-dev.tabmail.ai/ws` in debug mode (ADR-DESK-018); switching
  debug mode connects to the other one. The access token, from `validToken()`, goes in the address
  and is never logged; a close with 4001 (token expired) reconnects at once with a refreshed one.
- **Lifecycle.** Connected, Voice asks every device for its texts before offering any. The exact
  ping every 30 s; a probe every 5 minutes; a lost connection tried again after 5 s, doubling up to
  300 s, ten times, then at the next wake (`powerMonitor` `resume`) or return online (`net.isOnline`,
  looked at every 30 s); a wake connects afresh. Sign-out, the switch off, consent withdrawn and quit
  disconnect. Every number is in `config.ts`.
- **Size.** A message over the relay's 128 KiB is not sent (the relay would drop it, saying nothing):
  `log.error` names the fields and the sizes only, and Settings says "Too large to sync. Remove some
  bullets to sync again." under the switch until a send fits.
- **Copy.** The factory reset's confirmation for the knowledge base file says the other devices keep
  theirs and Device Sync brings them back.

**Consequences:**
- A bullet removed on one device may stay on another that was offline or mid-exchange: neither can
  tell a removal from a bullet it never received, and keeping it is the side that loses nothing;
  removing it there too clears it. Thunderbird with Thunderbird behaves the same. Owner blessing
  pending.
- Thunderbird and iOS keep their own hazards, unchanged here: a device that never synced takes a
  newer text whole (Voice's ancestor message covers the case Voice causes); a reset there keeps its
  ancestor.
- The knowledge base and writing style leave this computer, to the user's other devices through the
  relay, which keeps nothing (root ADR-004 is about email content; these are the user's own notes).
  The consent page's "kept only on this computer" for them changes with the owner's wording.
- Tests: `test/core/sync/deviceSync.test.ts` (merge, wipe, lifecycle and size cases),
  `test/core/sync/deviceSync.fuzz.test.ts` (seeded orderings with resets, factory resets,
  disconnections and probes; `DEVICE_SYNC_FUZZ_SEEDS` runs more), `test/main/deviceSyncSocket.test.ts`,
  and the Device Sync cases of `test/main/index.test.ts`, `test/core/settings.test.ts` and the
  Settings page's tests.
