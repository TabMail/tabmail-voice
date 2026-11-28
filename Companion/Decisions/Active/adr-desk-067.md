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
  sign-in is kept (sign-out follows only a refusal from sign-in: a 400, 401 or 403, or a session for
  another user).
- The app's own code reaches the network only through it. An ESLint rule (`eslint.config.mjs`) refuses
  in `src/` the global `fetch` (the name kept or handed on), any member named `fetch` whatever holds it
  (`globalThis`, `global`, `window`, `self`, Electron's `net`, a session), read or taken out, and
  Electron's `net.request`; Electron's modules, under every name Electron gives them (`electron`,
  `electron/main`, ...), are imported by name, and `net` as `net`, so the rule sees its requests. A
  use of the app's own member named `fetch` is refused too: it is renamed, or listed with its reason.
  Exempt: the transport itself; `web_read`'s `liveWebFetch`, which reads any web page, follows its
  redirects and carries no token (ADR-DESK-030); the PDF reader's stand-in that refuses the network.
  The exempt files keep the import rule and `net.request`'s.
- Device Sync's connection is Node's own WebSocket, which never follows a redirect; a test pins it.
- Unchanged: the update feeds on `cdn.tabmail.ai` (`electron-updater`; signed, no token) and the memory
  helper's model download.

**Consequences:**
- If one of these servers ever answers with a redirect, the request fails as a network failure; the
  fix belongs on the server.
- A new request to TabMail's servers goes through `liveTransport` (the lint rule says so); a direct
  fetch of anything else is added to the rule's exemptions with its reason.
- Tests: `test/core/backend/http.test.ts` (301, 302, 303, 307 and 308, to another server and on the
  same one, for a GET, a POST with a body, the same with the caller's signal, and with the signal and a
  stream consumer: the request fails as a network error, the redirect's target sees nothing and the
  consumer hears nothing of the redirect's body, while plain `fetch` follows the same redirect);
  `completions.test.ts` (an agent round, with the hold's signal and a listener for the backend's
  tools, against the same redirects carrying a stream that names a tool: the listener hears nothing;
  the same stream from a server that answers it reaches the listener); `account.test.ts` (the real
  token refresh against a sign-in server answering 307 or 308: the refresh token goes nowhere else
  and the sign-in is kept, and the next refresh, once the server answers it, keeps its new token);
  `test/main/deviceSyncSocket.test.ts` (the WebSocket meets the same redirects, to another server and
  on the same one); `test/eslintConfig.test.ts` (what the rule flags; every source file has it but the
  three exempt ones, and no file beside them is exempt). The two loopback servers are
  `test/support/redirectServers.ts`.
