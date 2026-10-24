## ADR-DESK-009: The app identifies itself to the backend as `voice` (was `macos`)

**Context:** Owner, 2026-09-25: the platform the Mac app reports should be called macOS, and the
admin panel should show it.

**Decision:** `X-Client-Type` is `macos` (was `desktop`). The admin panel counts `macos` usage as
its own device, beside Thunderbird and iOS.

**Consequences:**
- The backend reads the Thunderbird prompts for any client type other than `ios`, so prompt and
  tool resolution are unchanged.
- Usage recorded under `desktop` during development (2026-09-24 and 25) keeps that label.

**Amendment 2026-10-10 — `voice`:** Owner: the app "advertises itself as macOS, but it should
advertise itself as" Voice, in the app, the backend and the admin panel; it now runs on Windows and
Linux as well. From 0.2.0 `X-Client-Type` is `voice` on every platform. The backend reads `voice`
and the `macos` that 0.1.x sends as the same client (its Voice registries and tools, usage recorded
as `voice`), and the admin panel counts usage recorded as `macos` under Voice.

