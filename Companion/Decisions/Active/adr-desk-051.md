## ADR-DESK-051: Agent mode reads a PDF the user approves, parsed in a disposable sandbox, redacted in the helper

**Context:** Answer's model finds files through Spotlight (`files.ts`) but could not read one. The
Thunderbird add-on reads PDF attachments with PDF.js (`attachment_read_pdf`); agent mode does the
same for a local PDF (owner: PDF.js on every platform). A PDF is hostile input: its bytes are the
attacker's, its text may hold secrets, and a parser bug must not reach the app.

**Decision:** `file_read_pdf` (`src/core/agent/connectors/pdf.ts`, backend schema
`file_read_pdf-v0.1.3`) reads up to `pdfMaxPages` pages from a page the model chooses, after the user
approves the exact file. `src/main/documents/`:

- **The file** (`localDocument.ts`): a regular file in the home folder, at most `documentMaxBytes`.
  Preparing it reads only its metadata; the read opens it without following a symlink, checks it is
  the same file, and reads that descriptor.
- **The parser** (`pdfProcess.ts`, `pdfWorker.ts`, `pdfRealm.ts`): each read runs in a new Electron
  utility process with no stdio, a parent-owned deadline and a working-set watchdog; what bounds the
  parser's memory is that watchdog and the interpreter's arena. In it PDF.js runs inside a QuickJS
  interpreter with one fixed WebAssembly memory, with no fetch, rendering, fonts or workers; its host functions are text decoding and
  encoding and the bundled predefined CJK CMaps (`bundledCMap`, by file name only). Errors leave the
  process as classifications, never parser messages. The reply is bounded and checked page by page.
- **The text** (`pdfExtraction.ts`, `pdfReader.ts`): at most `pdfMaxTextBytes`, streamed page by
  page. The pages are joined and redacted in the platform helper by the shared Rust core
  (`redactText`, ADR-DESK-046) together with up to `pdfRedactionContext` of the text just outside
  the range on each side (the previous page's end, the next page's start or a cut page's rest), so a
  secret crossing an edge is recognized whole; only the range comes back. A redaction failure
  returns no text. A private key longer than that context, whose header is outside it, is still
  found: a text that starts inside a key's body (two or more full lines of base64 at its very start)
  is redacted up to the key's end line (`private-key-body`, owner 2026-10-05: "redact key bodies
  anywhere"); it applies to screen reads too, where a window scrolled past a key's header starts
  inside its body. And two or more full lines of base64 one after another go wherever they are
  (`private-key-lines`): a page of a printed key between a running header and a footer starts with
  neither a header nor its body, and whatever pages are read, with whatever layout, no line of a key
  comes back (amended 2026-10-07: a body's first line may follow a label on its line, after a space
  or a tab, as when the screen read joins a label and the block beside it). The owner's cost: any such run goes, a list of long hashes or a base64 blob included;
  one such line alone stays.

**Rationale:** The sandbox bounds what a malicious PDF can do to time, memory and a refusal; it
needs no native addon (PDF.js's optional canvas addon is left out of the package). Redacting with
the context, rather than withholding text near an edge, returns the text a whole read would, CJK
text without spaces included.

**Consequences:**
- No OCR: an image-only page reads as no text, and says so.
- A font that names a CMap PDF.js does not ship reads as no text.
- The context is part of the read (owner, 2026-10-05: accepted and documented): a neighbouring page
  that cannot be parsed, or that is so large reading it runs past the parse deadline, refuses the
  pages next to it as well. The tool's description tells the agent a refusal may come from a
  neighbouring page, so it does not retry the same pages.
- The package keeps only PDF.js's `legacy/build/pdf.mjs`, `pdf.worker.mjs` and `cmaps/`
  (`electron-builder.json`); the release check asserts it (`verify-pdf.cjs` in the helpers repo).

---

