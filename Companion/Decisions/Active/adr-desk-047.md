## ADR-DESK-047: Websites the screen is never read on, with the password managers' web vaults built in

**Context:** An excluded app (ADR-DESK-045) is the whole app. A bank or a password manager's web
vault open in a browser was read unless the whole browser was excluded. Owner, 2026-09-30 and
10-01: websites can be treated as an app is, excluded one by one (#77), and the check stays in the
helper, the same in every platform's helper.

**Decision:** An excluded website is never read. The list is the built-in web vaults
(`config.builtInExcludedSites`: 1Password's, Bitwarden's, Google Password Manager's, LastPass's,
Dashlane's and Proton Pass's), excluded in every installation and not removable, plus the sites the
user adds (`AppSettings.excludedSites`, kept on this computer). A site is known by its host
(`example.com`), which covers its subdomains (`mail.example.com`) and no host that only ends or
starts alike; case and a trailing dot don't matter.

- The key-down snapshot (ADR-DESK-017) carries the hosts (`DictationSettings.excludedSites`) beside
  the apps, as one `ScreenExclusions`. Both go with the screen read and with every read of the
  pasted-into field: `readScreen` and `focusedFieldValue` take `excludedAppIDs` (renamed from
  `excludedBundleIdentifiers`, so that every platform's helper uses one name) and `excludedHosts`.
- `voice-macos` refuses (`Privacy/ScreenExclusions.swift`, which holds both matches and the
  fail-closed reading of the two lists). The page the caret is in is checked first, before the
  caret's text or the window's title is asked for (`ScreenContextReader.gather`): every web area
  above the focused element, and the focused element itself, since a page clicked on or selected in
  has the focus itself, and any page inside the focused element (a page that frames an excluded
  one, a focused group holding one: `holdsExcludedPage`), looked into before the caret's text is asked for. The walk then refuses the whole window at any page of an excluded site, in
  focus or not, framed in another page or inside a row, a heading or a link that has no label of its
  own (one with a label gave its label, and nothing inside it was looked at; amended below,
  2026-10-01: it is looked through first): with the caret in the
  browser's address field the page is still on screen. `readScreen` answers that the screen is hidden, as for an excluded
  app, and drops a context whose host is excluded whatever the reader did. A refused read gives
  back nothing of what it had gathered (`gather` answers no context at all). `focusedFieldValue`
  answers no value for a field whose window shows a page of an excluded site: the field's own
  pages, what the field holds, and the rest of its window, so the address field of a browser showing
  an excluded page is not read either (owner, 2026-10-01). A request without either list is an
  error.
- Read only what can be told safe (owner, 2026-10-01): a page whose address the app fails to give
  (the lookup timed out, the app gone) is treated as excluded, wherever it is (`PageHost.unknown`).
  Only the app's answer that the page has no address makes it a page with no host, which is read.
- Which host a site covers is one rule for the app and every helper:
  `native/shared/privacy/host-exclusion-cases.json`, which the app's `coversHost` and each helper's
  match are tested against, as the redactors' cases are (ADR-DESK-046).
- Settings › Privacy: a field takes a site by its address (`https://mail.example.com/inbox` is kept
  as `mail.example.com`: `excludedSite` drops the scheme, sign-in, port and path), the user's sites
  with a Remove button each, and the built-in ones named in a note. At most `exclusionsMax`, as for
  apps (ADR-DESK-045).
  A site that could not be saved, or a removal that could not, did not happen and is said so, as
  for an app (ADR-DESK-045).

**Consequences:**
- A window showing an excluded site gives no screen context at all, not the rest of the window
  either: a dictation there is as one in an excluded app.
- The host is the page's as the browser reports it through Accessibility (a web area's URL). A
  browser that doesn't report one, or a site inside an app that hides its pages' addresses, is read.
  A page in a background tab is not on screen and doesn't count.
- A page that frames an excluded site (a payment form from an excluded host) is not read either.
- A window with a page whose address lookup fails gives no screen context for that dictation, and
  ends the watch for corrections, whatever the page is.
- A walk that runs out of its node or time budget before reaching a page out of focus never saw
  that page: what it gathered before, and the window's title, are kept. The page's own text is not
  among it. The look inside the focused element keeps to the same budgets. Kept as it is (owner,
  2026-10-01): failing closed would drop the context of every large window.
- Before a field is read for corrections its window is looked through for pages, every half second
  while the watch runs, so for at most `focusedFieldPageScanBudget` (0.2 s) and without going into a
  page that is not excluded: a page framed in another one beside the field, or one not reached in
  that time, does not stop the read. The field's text stays on this computer.
- Only `http` and `https` pages have a host; an extension's page (a password manager's browser
  extension) can't be excluded by host, and its password fields are skipped as everywhere.
- Hosts are ASCII: a site with an internationalized name is added in its `xn--` form.
- The built-in hosts are the vaults' addresses as known when this was written; one that moves is
  read until the list is updated or the user adds it.
- Windows and Linux take the same two lists with their helpers' screen read, and run the shared
  host cases.

*(Amended 2026-10-01, owner: an element the Mac helper reads in one piece is looked through for an
excluded page first, as the Windows helper does. A row, a heading or a link with a label of its own,
a piece of text, and a web control with a title are read by that label and never walked into, so a
page inside one was not seen, and a label can be made of what the element holds. The walk now looks
through each such element that is shown (`holdsExcludedPage`, for pages only) and refuses the whole
window when it holds a page of an excluded website or one whose address is unknown, the same answer
as for a page the walk reaches itself: a page in a row is a page the window shows. So for a piece
of text or a titled control inside a row whose text is gathered. A field that frames such a page is
the other case and keeps its own answer, the marker in its place, in the window and in a row with
no label (#94; Windows: #96); inside a row, heading or link read by its label, where the field is
never reached, it refuses the window like any page there. Only a control with a title is
looked through: one without is walked into, and what is in it gets its own answer. The look keeps
to the walk's budgets; an element it could not look through whole (more elements than the read's
element budget, or the read's time running out mid-look) is not read, and the marker stands in its
place, as for a field (`lookForExcludedPage`), since a page the look did not reach might be an
excluded one. It asks every such element for its children, which the walk did not before; what
that costs on a large page was not measured on a live app (on a made-up tree of labelled rows,
texts and buttons, about twice as many questions to the app).)*

*(Amended 2026-10-01, owner: an excluded page that lies wholly outside the window is skipped
without hiding the window, which is what the Mac helper does. The Windows helper answers "hidden"
for it, before checking that the page is inside the window and shown; neither helper reads that
page, so the Mac's answer loses nothing and reads more. The Windows helper is to follow: #97.)*

**ADR-DESK-047 amendment — shared address classification (2026-10-03):**
Provider address acquisition and unavailable/absent evidence stay native. The Rust
core classifies supplied addresses with the pinned WHATWG `url` parser; malformed
or recovered ambiguous addresses are unknown, never absent. Empty addresses remain
absent. HTTP(S) uses canonical hostnames; non-web addresses match their scheme,
preserving extension/file/vault exclusions. Exclusion matching keeps the original
Unicode-folded comparison and recognizes IDNA/numeric aliases, so canonicalization
cannot discard a stored exclusion. IDNA conversion precedes full case folding.
The shared address/host fixtures pin this policy across all native adapters and the
app; platform parser differences are recorded in the consolidation plan.

**ADR-DESK-047 amendment — which Windows documents are pages (2026-10-05):**
UI Automation gives Notepad's and Word's text as a Document too, and the Windows helper took
every document for a web page: one without an address hid the whole screen as of an unknown
address (Notepad read as hidden in the Windows smoke test). A document is now no web page only when
its UI framework (`UIA_FrameworkIdPropertyId`) is one of an app's native controls, `Win32` (Notepad's
and Word's text), `WinForm`, `WPF`, `XAML` or `DirectUI` (`HelperConfig::nativeDocumentFrameworks`):
it is read like the rest of the screen, and the app exclusion still applies to it. Every other
document is a page whose address is checked, a browser engine's (`Chrome` in every Chromium browser
and Electron app, `Gecko` in Firefox and its forks, `InternetExplorer`) and equally one whose
framework is empty (UI Automation's default, which a provider or proxy that doesn't supply it
gives), unknown or can't be read (fail closed). A list of web engines instead read an excluded site
whenever the engine gave no framework. This keeps
the Mac's rule (a web area is a page, in an app or a browser alike) instead of a list of browser
names, which would read an excluded site in any browser not on the list.

*(Amended 2026-10-05, owner, through ADR-DESK-054: the Windows helper now answers a look that runs out
of budget as the Mac helper does. An element it reads in one piece (a piece of text, a field, a
titled web control, a row, a heading or a link, in the walk and in a row's text) that it could not
look through whole is withheld and the marker stands in its place; a selection in a page and a
terminal window it could not look through whole are not read. It used to treat such a look as
"no excluded page" and read the element. The two cases kept above stand: the walk keeps what it
gathered when its own budget runs out, and the 0.2 s look before a field is read for corrections
does not stop that read.)*

