## ADR-DESK-004: Phase 1 needs no account and no backend

> ⛔ **SUPERSEDED by ADR-DESK-005 (2026-09-24):** server STT makes sign-in a phase-1 requirement. Kept for history.

**Context:** Phase 1 is "dictation anywhere, nothing complicated".

**Decision:** Phase 1 ships without TabMail sign-in or backend calls. Sign-in (Supabase, mirroring
iOS `TabMailAuthService`) arrives with the first backend feature: AI cleanup in phase 1b or phase 2.

**Consequences:** Adding backend features later requires the backend to recognize a `desktop`
client type.

