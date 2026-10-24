## ADR-DESK-026: Files, Spotlight search the Answer tool can open from

**Context:** Owner, 2026-09-26: the Answer tool finds files ("the PDF from last week") and, where the
user has Apple Mail, its messages, through Spotlight, and opens a hit; one switch, on by default, in
Settings and the wizard (ADR-DESK-024). Opening is neither sending nor creating, so it asks nothing.
The backend defines `files_search` and `file_open` (`src/tools/macos/`). First built in the Swift
app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `files` connector with `FilesSearchTool` (`files_search`) and `FileOpenTool` (`file_open`)
  (`src/core/agent/connectors/files.ts`) over a `FileStore`: on macOS `MacSystem.fileStore`, whose
  `filesSearch` and `fileOpen` requests `voice-macos` carries out (`FileSearch.swift`). A failure
  comes back by name (`Files.Failure`, `FileStoreError`), so a file's name in the system's error
  never reaches a log.
- `SpotlightQuery` (in the helper) builds the query: every word in the display name, the text
  content (word prefix), or an email's subject, senders or sender addresses, ignoring case and
  accents; a kind from the backend's list as content types (`document` = composite content or
  text); `changed_after`/`changed_before` on the content change date, a day as the end reading
  through that day (the app reads the dates, `Arguments.localDate`/`localEnd`, and sends them in
  milliseconds). Words are escaped, so a quote cannot end a value and `*` matches itself. `MDQuery`
  runs synchronously off the main thread, in the home folder, gathers at most
  `HelperConfig.filesSearchScanLimit`, and keeps the newest (`Files.newest`); the app asks for
  `filesSearchMaxResults` + 1 to say that more match. Paths go to the model with the home folder as
  `~`, which `file_open` expands (`~user` and relative paths are refused).
- Apple Mail messages are found when Spotlight has indexed them (`.emlx`, shown by subject and
  sender) and opened like any file, by path: Launch Services opens them in Mail.
- `OpenPolicy` (in the helper): `file_open` opens only a plain folder or a type conforming to PDF,
  image, audiovisual content, presentation, spreadsheet, composite content, text or email, and not
  to source code (scripts are source code), to executable (macro-enabled Office documents, `.xlsm`,
  `.docm`, `.pptm` and the like, are composite content and executable) nor to the XML types that launch a Java app or install a
  configuration profile (`.jnlp`, `.mobileconfig`, `.configprofile`, `.provisionprofile`), which
  the Swift app opened. Anything else (apps, `.command`, installers, Terminal settings,
  `.webloc`/`.fileloc` links, disk images, archives, shortcuts, no extension) is none of the opened
  types and is shown in the Finder instead, and the model is told why; `reveal` shows even a
  document. The type comes from the name's extension, as Launch Services picks the opening app by
  it; a symbolic link or a Finder alias, which opens what it points to whatever its own name says
  (`Invoice.pdf` pointing at a script), is only shown. A path planted in screen text or a file can
  therefore at most open a document.
- A package (a folder the Finder shows as one item) is typed as a package (`.rtfd` names only a
  package type) and opens only when it is rich text with attachments or a Pages, Keynote or Numbers
  document (`OpenPolicy.openedPackages`). Most other packages are composite content too, among them
  Xcode projects, workspaces, toolchains and playgrounds, Swift packages and app preference bundles,
  several of which run or install something as they open, so every other package is only shown
  (review 2026-09-28: the extension-only lookup showed a real `.rtfd` and told the model it could run
  something; a census of this Mac's registered package types found those among the composite ones).
- An item that isn't there fails (`openFailed`), shown or not: the Finder shows nothing for a missing
  item and reports nothing, so the model would otherwise say it showed it.
- The Swift app's shown-only list also named application and property list; no type among the
  opened ones conforms to application, and the property lists that are text (`.entitlements`,
  `.aupreset` and the like) are harmless XML, so both are left out.

**Consequences:**
- No new permission: Spotlight queries and Launch Services need none. Which items in folders macOS
  protects Spotlight returns to the helper is macOS's call; the app asks for no Full Disk Access.
- Found names, paths and email subjects go to the model only: nothing is stored (ADR-004).
- A search as broad as one letter sees only the first `filesSearchScanLimit` items Spotlight
  gathers, not necessarily the newest.
- An HTML page, an `.ics` or a `.vcf` is a document here: it opens in the browser, Calendar or
  Contacts, which ask before importing anything.
- Offered on macOS only, with the other connectors.

