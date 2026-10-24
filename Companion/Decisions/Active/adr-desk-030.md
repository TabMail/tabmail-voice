## ADR-DESK-030: The web, searched on the backend, read and opened on this computer

**Context:** Owner, 2026-09-26: the agent can search the web and read and open pages. One switch,
on by default, in Settings and the wizard (ADR-DESK-024). The backend defines `search_web` (which
runs on the server), `web_read {url}` and `web_open {url}`. First built in the Swift app; built here
in the Electron app (ADR-DESK-032).

**Decision:**
- The `web` connector with `WebReadTool` (`web_read`) and `WebOpenTool` (`web_open`), in
  `src/core/agent/connectors/web.ts`, and the backend's `search_web`. A connector's backend tools
  (`Connector.serverTools`) are listed in `available_tools` after the date tools while its own tools
  are (switched on at key-down, and on this computer), so a platform without the web's tools offers
  no search either; `web_search_enabled` is sent as whether `search_web` is listed (the backend refuses
  `web_read` and `web_open` too without it).
- `web_read` is a port of the add-on's `web_read` and the iOS app's `WebReadTool`
  (`WebPageReader`): the site's robots.txt is asked first (one that can't be read allows; a cancel
  ends the read), then the page, both as `webUserAgent`; an HTML page comes back as its text
  (extracted by the add-on's rules, without a DOM), other text as it is in the charset it names
  (UTF-8 for one the runtime doesn't know), cut at `webReadMaxCharacters`, in the same result
  format. The fetch (`liveWebFetch`, injectable as `WebFetch`) follows redirects, as the add-on's
  does, and reads at most `webReadMaxBytes` of a body, so an endless page never fills the memory.
- `web_open` opens the page in the default browser (`shell.openExternal`). Both take only a
  complete `http`/`https` URL with a host: another scheme could open an app (a `shortcuts:` link
  runs a shortcut).
- Neither asks first: reading and opening a page is neither sending nor creating (ADR-DESK-023).
  Which URLs the model may pass is the backend's guard, the one `web_read` has on every platform:
  only a URL the user said or one in an earlier tool result, never a private address, and never a
  URL that appears only on the screen (the screen read is text the model can't vouch for).

**Consequences:**
- A page on the user's screen can be read or opened only once the user says its address or a search
  finds it.
- Pages go to the model only: nothing is stored (ADR-004).
- The robots.txt group match is the add-on's: a group applies when its `User-agent` is `*` or the
  whole `webUserAgent` string, so a group naming TabMail by a short token is not read as ours.
- The main process decodes a charset with Electron's `TextDecoder`, which reads `windows-1252`
  0x80–0x9F as curly quotes and dashes; plain Node 24, which runs the tests, decodes them as control
  characters, so the tests use an ISO-8859-1 page.
- The text is extracted on the main process, so extraction takes time linear in the page: each
  chrome element is found with its closing tag in one pass, and a tag ends at the next `<` or `>`.
  A regex that rescans to the end from every unclosed `<` (a lazy `<script>…</script>`, or
  `<[^>]+>`) held the app for 35 seconds to 4 minutes on a hostile page of half a million `<` or
  `<script` (review, 2026-09-28). A chrome tag's name ends at a space, `/` or `>`, so a custom
  element such as `<nav-menu>` stays page text, and a closing tag may have spaces before its `>`.
- Offered on macOS only, with the other connectors.

**Amendment 2026-10-07 (owner): `web_read` no longer asks robots.txt.** robots.txt is written for
crawlers, clients that walk a site on their own; `web_read` reads one page because the user asked,
as a browser does, and browsers don't ask it. The group match above was also wrong (only `*` or the
whole `webUserAgent`, not RFC 9309's product token, issue #45; and a later group for another crawler
cleared the rules gathered from `*`), and rather than fix it the check is gone: `robotsAllow`,
`isPathAllowed` and `webReadRobotsTimeout` are deleted, and a read is the page alone. TabMail stays
named in `webUserAgent`, so a site can see who asks and block it, and the backend's URL guard is
unchanged. The Thunderbird add-on (its ADR-026) and the iOS app drop the check in the same change,
and the backend's `web_read` description no longer says the tool respects robots.txt. This replaces
the robots.txt steps in the decision and the group-match consequence above.

