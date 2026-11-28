## ADR-DESK-067: Requests to TabMail's servers never follow a redirect

**Context:** The app's requests to TabMail's servers (the backend at `api.tabmail.ai` and
`dev.tabmail.ai`, sign-in at `auth.tabmail.ai`, Device Sync's relay at `sync.tabmail.ai`) carry the
access token, or the refresh token in the token refresh's body. None of these servers answers with a
redirect, but `fetch` follows one by default, and a 307 or 308 keeps the method and the body: a request
that followed one would take what it carries to the address the redirect names. The iOS app and the
Thunderbird add-on make the same change.

**Decision:**
- `liveTransport` (`src/core/backend/http.ts`), the one transport for these requests (sign-in, the
  token refresh, transcription and its warm-up, completions), fetches with `redirect: "error"`. A
  redirect answer rejects the fetch, which callers get as `TransportError("network")`, the same as a
  lost connection ("Couldn't reach TabMail."). The token refresh treats it as any network failure: the
  sign-in is kept (only a 400, 401 or 403 from sign-in signs out).
- The app's own code reaches the network only through it. An ESLint rule (`eslint.config.mjs`) refuses
  the global `fetch` in `src/`, under any name (`globalThis`, `window` or `self` `.fetch`, the name kept
  or handed on), and Electron's `net.fetch` and `net.request`. Exempt: the transport itself;
  `web_read`'s `liveWebFetch`, which reads any web page, follows its redirects and carries no token
  (ADR-DESK-030); the PDF reader's stand-in that refuses the network.
- Device Sync's connection is Node's own WebSocket, which never follows a redirect; a test pins it.
- Unchanged: the update feeds on `cdn.tabmail.ai` (`electron-updater`; signed, no token) and the memory
  helper's model download.

**Consequences:**
- If one of these servers ever answers with a redirect, the request fails as a network failure; the
  fix belongs on the server.
- A new request to TabMail's servers goes through `liveTransport` (the lint rule says so); a direct
  fetch of anything else is added to the rule's exemptions with its reason.
- Tests: `test/core/backend/http.test.ts` (301, 302, 303, 307 and 308, for a GET and for a POST with a
  body: the request fails as a network error and the second server sees nothing, while plain `fetch`
  follows the same redirect); `account.test.ts` (the real token refresh against a sign-in server
  answering 307 or 308: the refresh token goes nowhere else and the sign-in is kept);
  `test/main/deviceSyncSocket.test.ts` (the WebSocket); `test/eslintConfig.test.ts` (what the rule
  flags, and where). The two loopback servers are `test/support/redirectServers.ts`.
