## ADR-DESK-019: Dictate in the keyboard's language, shown beside the waveform

**Context:** Owner, 2026-09-26 (issue #3): dictation must work in languages the backend's default
model does not cover (Korean first). The keyboard's language shows as a small circle left of the
waveform, as other dictation tools do; the request sends the language, and the backend picks the
model for it from a JSON file of language–model pairs (backend ADR-024).

**Decision:**
- At key-down, beside the app in front, `DictationController.start()` reads the active keyboard input
  source's language once (`KeyboardLanguage.current()`, Text Input Sources) into `language`. The
  recording is sent with it (`TranscriptionClient.transcribe(wav:language:accessToken:)`) and the
  overlay's badge shows it, so the two can never disagree. A keyboard switched during the hold or the
  upload applies from the next hold.
- The language is the source's first one, reduced to its ISO-639-1 primary subtag (`zh-Hans` → `zh`,
  `pt_BR` → `pt`); without a two-letter code (`yue`, `fil`, or no languages) none is sent and no badge
  shows. Every source's first language counts: macOS lists a Korean 2-Set's languages as `["ko"]` but
  the U.S. layout's as 96 languages with English first, so "several languages → none", as the issue
  first proposed, would have left every English keyboard without a language.
- It is sent for every language, including those the default model covers; the backend decides what
  it means (today: a model for the languages the default lacks, the model's own detection
  otherwise).
- The badge: the code in capitals (`KO`) in a small gradient-ringed circle, as tall as the waveform
  (the pill keeps its height), concentric with the pill's rounded left end, while the pill listens
  (not in the thinking circle or a message).

**Consequences:**
- The keyboard is a proxy: Korean said with the U.S. layout on goes to the default model, which does
  not cover Korean. There is no manual override in Settings yet; add one if that proves common.
- Needs the backend with ADR-024 deployed first: the earlier backend forwarded the language to its
  default model, asking it for languages it does not cover.

