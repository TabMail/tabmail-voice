## ADR-DESK-066: Device Sync of the knowledge base and writing style with Thunderbird and iOS

**Revised 2026-10-29: labelled bullets (Device Sync v2).** The first design (kept below under
*History*) merged whole texts by time with a remembered ancestor. Its fuzz and review rounds kept
finding orderings where a device lost a bullet or never settled, and Thunderbird and iOS had the same
class of bug in their own merge. Voice, Thunderbird and iOS now share one design: every bullet carries
a label, and a merge is a set operation that never depends on time. This PR is Voice's; Thunderbird and
iOS follow with the same rules, the same test vectors and the same default catalog, byte for byte.

**Context:** Owner, 2026-10-17: Voice joins Device Sync (root ADR-021), the relay Thunderbird and iOS
sync through, for the knowledge base and the writing style (ADR-DESK-063). Owner-critical rule: a
device never wipes another device's knowledge base or writing style. The relay forwards each message
to the user's other connected devices and keeps nothing; messages can be lost, repeated or reordered,
and devices can be offline for weeks, copied, restored from a backup or reset.

**Decision:**
- **What is synced.** `kb` and `composition` (DS-VOICE). Thunderbird's action rules use the same
  format there; Voice ignores them, and every other relay field. Opt Out of AI and the Device Sync
  switch are this computer's and never sent. `ai_cache_probe` is answered at once with an empty
  `ai_cache_response` under the same `probeId`.
- **Labelled bullets.** A field is its own skeleton (the lines around the sections, never synced), its
  live bullets in order, each `(section, text, label)`, and a seen map: per writer name, the highest
  counter this device has seen. A label is a writer name and a counter. A writer name is 16 lowercase
  hex digits, drawn fresh by each process; the labels carrying it are stored, but no process keeps it
  as its own name, so two copies of one store never share one; any failed save, reset or reload
  abandons it (one name per process for every field). A catalog
  default's label is `default:<id>` with counter 1, the same on every device
  (`src/core/sync/device-sync-default-catalog.json`).
- **Local changes.** An add gets a fresh label (a text already live is not added twice); a delete
  removes every live label of the text; an edit or a move is a delete and an add. An operation that
  showed the user (or a model) some bullets and saves later deletes only the labels it showed: a
  bullet that arrived in between stays. Settings hands back the labels it displayed (`ShownBullet`);
  `kb_del` deletes from the labels read at key-down. Each commit writes the bullets and the seen map
  together, in one write.
- **Merge** of a complete incoming snapshot (bullets and seen map): a local label the sender lacks is
  dropped only when the sender's seen map covers it (it saw it, so it was deleted there); an incoming
  label new here is taken only when this device's seen map, as it was before this merge, doesn't cover
  it; a label holding other text or section here refuses the snapshot; the seen maps take the maximum;
  then one label per (section, text) is kept, the smallest. No time, no ancestor, no hold decides
  anything.
- **Messages** (`bullet_state`): the field's full state on connect, after every local change, and in
  answer to a merge whose incoming labels differed from this device's. Its seen map carries only the
  names on its bullets and on the last snapshot merged for that field. Over the relay's budget it is
  sent in parts, and a snapshot is applied only when every part arrived, agreeing; one bullet alone
  over the budget holds the field back and Settings says "Too large to sync". A malformed part drops
  the whole snapshot, except one whose sender or snap is no string: it is dropped alone, since with no
  sender there is no snapshot to key (R27). Voice never asks for state and never sends the released format. The relay
  also limits how many messages a connection sends a minute, and every part counts: a field of
  dozens of parts (megabytes, far beyond a real knowledge base) would be cut off on each connect.
  Left as it is (2026-10-29).
- **Capture epoch (R30, 2026-10-29).** Each field has a capture epoch, in memory only. Every operation
  that can await between reading a field and writing it takes the epoch once, at its start, and every
  write it makes carries it as a required argument: Settings' edits (one epoch per field view, `Shown`,
  so an empty list carries one too), an agent request's `kb_add` and `kb_del` (`KnowledgeCapture`), a
  history restore. A reset of the field ends its epoch before the write tells anyone (put back if the
  write fails), and so does a reload of the fields (another account's claim, the texts' file reset).
  `BulletSync` refuses a write carrying an ended epoch, writing nothing, in one check for both commit
  paths. Settings' editor is keyed by the epoch, so a draft in a row or the field to add one is dropped
  then. Sign-out doesn't touch the texts, so it ends nothing; the next account's claim does.
- **Released Thunderbird and iOS** (`prompt_state`): imported additions only, an epoch-zero text
  skipped; nothing is deleted from what they send.
- **Upgrade.** The texts Voice kept before are parsed once: catalog defaults take their default label,
  every other bullet a fresh one; the old keys go in the same write. A reset puts back the defaults
  with a fresh seen map, so nothing it removed is deleted elsewhere: the other devices' bullets come
  back.
- **Where it lives.** `src/core/sync/bullets.ts` (parse, render, labels, local operations, merge),
  `src/core/sync/bulletSync.ts` (`BulletSync`: the writer name, commits, the wire, parts),
  `src/core/sync/deviceSync.ts` (`DeviceSync`: the connection), `UserPrompts` the store
  (`bullet_state:<field>`). The transport is `src/main/deviceSyncSocket.ts`. All free of timers that
  affect what is kept: the only timers keep the connection alive (ping every 30 s) and try it again
  (5 s doubling to 300 s, ten times, then at the next wake or return online).
- **When it runs** is unchanged: for the account signed in, from a texts file that could be read,
  while `AppSettings.deviceSyncAllowed`; another account signing in resets the texts to the defaults
  (`UserPrompts.claim`).

**Consequences:**
- A bullet deleted on one device is deleted on the others once they exchange states, however late or
  in whatever order; a bullet no user deleted is never lost (tested as invariants, below).
- The seen map grows by one entry per writer name (per process run that wrote). Small: names are
  never reused.
- The knowledge base and writing style leave this computer, to the user's other devices through the
  relay, which keeps nothing (root ADR-004 is about email content; these are the user's own notes).
- Tests: `test/core/sync/device-sync-vectors.json`, the scenarios and parse cases Thunderbird and iOS
  run unchanged, run by `test/core/sync/deviceSyncVectors.test.ts` (it pins the vectors' and the
  catalog's SHA-256); `test/core/sync/deviceSync.fuzz.test.ts`, seeded runs of 3 to 6 devices with
  edits, resets, restarts, failed saves, copies, restores, legacy peers, lost, repeated and reordered
  messages and lost parts, asserting no loss at every step, then convergence and quiet
  (`DEVICE_SYNC_FUZZ_SEEDS` runs more); `test/core/sync/deviceSync.test.ts` (wire, lifecycle, size),
  `test/core/personalization/prompts.test.ts`, `test/main/deviceSyncSocket.test.ts`, and the Device
  Sync cases of `test/main/index.test.ts` and the Settings page's tests.

## History: the first design (2026-10-17 to 2026-10-28)

Superseded by the revision above; kept as it was decided.


**Context (first design):** Owner, 2026-10-17: Voice joins Device Sync (root ADR-021), the relay Thunderbird and iOS
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
