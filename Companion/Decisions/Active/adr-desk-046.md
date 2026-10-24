## ADR-DESK-046: Secret-looking text is taken out of the screen read, in the helper, from one shared definition

> Since ADR-DESK-055 (2026-10-05) Edit of a redacted selection is refused when the agent writes it, after the loop has asked the backend; the redacted read is still all the backend sees.

**2026-10-03 amendment — shared Rust implementation:** The canonical JSON and screen-read privacy boundary remain. Every native helper now links the same Rust static library for matching and UTF-16 redistribution. Native ICU matching, generated Swift/C++ definition files and the ECMAScript conformance implementation are superseded; Rust tests own definition validation, corpus/mutations and hostile-text timing. Platform suites exercise that library through its C ABI. Keep provider access and pre-read password/exclusion checks native.

**Context:** The screen read skips password fields (ADR-DESK-007, amended 2026-09-30) and excluded
apps (ADR-DESK-045), but a secret shown as plain text is read like any other text and sent with the
dictation: an API key printed in a terminal, a token on a dashboard, a private key open in an
editor. Owner, 2026-09-30 and 10-01: the context should not capture secrets; simple heuristics are
good enough (#78); it belongs in the helper, which is small and ours, so that a secret never reaches
the Electron process; and the three platforms' helpers must share the same logic, with a
well-structured place for the redactors.

**Decision:**
- What looks like a secret is defined once, in `native/shared/privacy/redactors.json`: an ordered
  list of redactors, each a name, a regex, a case flag and a replacement. They cover private-key
  blocks (whole, or cut off where the window ends), JSON web tokens, `Bearer` tokens, the password in
  an address (`scheme://user:password@host`, with a user name or not; the password runs to the last `@` before the path, since a password may hold one), a value given to a name like `password`, `token`,
  `secret` or `api_key` (when it has a digit and at least 6 characters), and keys with a provider's
  prefix (`sk-`, `sk_live_`, `whsec_`, `ghp_`, `github_pat_`, `glpat-`, `AKIA`, `AIza`, `xoxb-`,
  `npm_`, `hf_`). A match becomes `[redacted]`; the name, the word `Bearer` and the rest of an
  address stay, so the text still reads.
- Each helper's list is generated from that file (`scripts/gen-redactors.mts`,
  `npm run gen:redactors`, run with the registries before every build, typecheck and test), as the
  connectors' registry is (ADR-DESK-044): macOS gets `Privacy/Redactors.generated.swift`, and a
  platform's helper adds its emitter there. No helper copies a pattern by hand. The generator
  refuses regex syntax ICU, ECMAScript and PCRE don't read alike (lookbehind, named groups, Unicode
  classes, inline flags, possessive and atomic groups, backreferences, and `\b`, `\w` and `\d`), and
  a replacement naming a group its pattern lacks.
- No pattern uses a word boundary. ICU counts every script's letters as word characters and
  ECMAScript only ASCII's, so a key written straight after a Japanese, Korean or accented word was
  kept by the Mac helper and redacted by the same pattern in JavaScript. Where a key must not start
  inside a word, the pattern takes the character before it (`(^|[^A-Za-z0-9_])`) and the replacement
  puts it back; where it must not run on, a lookahead says so.
- Every pattern takes time in proportion to the text. Screen text has no length limit, may be
  anyone's (a web page, a message), and is redacted with no deadline, so a repeat scanned again from
  every position is refused in review: it is bounded, or the pattern begins where a run begins (a
  key block's kind, before and after `PRIVATE KEY`, is at most 40 characters). Both suites time
  each pattern on hostile text.
- No run stops a redactor short. ICU runs an open-ended count (`{16,}`) and a repeated `\s` outside
  a class with a stack frame per repetition, and on a run of some 200,000 characters gave up,
  silently matching nothing after it: every later secret of that read was sent. The patterns use
  the forms it runs as one loop (`[..]{16}[..]*`, `[\s]*`), the generator refuses the others, and
  `Redactor.redact` asks the engine whether it finished: a redactor that did not withholds
  everything after its last match (`[redacted]` in its place).
- `native/shared/privacy/redaction-cases.json` is what every helper must do with them: each case's
  text and what it becomes. Every helper runs the cases in its own suite, on its own regex engine;
  that is what shows the helpers agree. The texts are split into fragments, so the file holds
  nothing shaped like a real key.
- `voice-macos` redacts every text of the screen read as it replies (`ScreenContext.json`, the one
  way a read leaves the helper; `ScreenContext.redacted`): the window's title, the visible blocks,
  and the text before, in and after the selection. The rendered text and the log description are
  built from the redacted blocks. The focused field's value for correction learning is redacted too.
- The texts of a read are redacted together, not one by one (`Redactor.redact` of several lines):
  as the one text they make, a line break between the blocks, and nothing between the three texts
  around the caret. A secret spread over several elements (a key's lines, one each; `Bearer` and its
  token) or one the caret or the selection is inside only shows once they are joined. Each text then
  keeps its share of the result: what replaces a secret goes to the text the secret began in, what
  the replacement keeps of the match's start and end stays where it was, and a text wholly inside a
  secret comes back empty (such a block is dropped; a selection left empty or blank becomes
  `[redacted]`, so it is still a selection, and Edit refuses it). The blocks are redacted before they are rendered, because the marks the rendering
  puts before a field's, a row's and the focused field's lines would break a key of several lines.
  The rule is the helpers' to share like the patterns: its cases are `lineCases` in
  `redaction-cases.json`, which every helper's suite runs.
- The reply says when the selection had a secret taken out (`selectionRedacted`). Agent mode's Edit
  then refuses (`AgentError.secretInSelection`), asking the backend nothing: its rewrite of the
  redacted selection, pasted over the real one, would put `[redacted]` where the secret was. The
  other tools still get the redacted selection. The helper's screen-privacy code lives in
  `Sources/VoiceMacOSKit/Privacy/`.
- Always on; not a setting, like the password-field skip.

**Consequences:**
- A safety net, not a guarantee: a secret in a shape the patterns don't know (a bare random string, a
  password with no name beside it) is still read. Long random strings are not matched by entropy,
  which would also take out hashes and identifiers.
- A password without a digit after a name (`Password: correcthorse`) stays, so that a form's
  `Password: required` does.
- A secret cut by the edge of what is read (the focused field's text is read 2,000 characters each
  side of the caret; a terminal's from its first visible line) is only found when the part read
  still has its shape: a private key's header and what follows are, its last lines alone are not.
- A selection holding a secret can't be rewritten by voice (Edit refuses, saying why); a plain
  dictation over it replaces it as always.
- Texts that sit side by side on screen are still joined by a line break here, so a name and its
  value in two elements are found together, and so are two elements that only look like one (a
  label ending in `token:` above an unrelated word with a digit). *(Amended 2026-10-07: the pieces
  of one line on screen, text and links, are joined as the screen shows them, with a space or with
  nothing where they abut (ADR-DESK-007's 2026-10-07 amendment); other texts side by side still are
  joined by a line break.)*
- A private key written on one line with its line breaks escaped (`\n` as two characters, as a JSON
  file or a quoted value holds it) is taken whole: the key's body may hold a backslash. One with
  header lines after its first (an encrypted PEM key, a PGP key with a `Version:` line) keeps its
  body, whatever name is beside it; a key header with nothing
  after it takes the letters that follow, up to the first punctuation. The key block's redactor is
  the last in the list for that reason: first, it took a later secret's name or prefix with those
  letters, and that secret's own redactor no longer knew it. *(Amended 2026-10-07 night, owner,
  #175: a key with a distinctive prefix is redacted glued to the letters before or after it. The
  edge before AKIA, AIza, `ghp_`, `github_pat_`, `glpat-`, `xox?-`, `npm_`, `hf_`, `whsec_`, `eyJ`
  and `sk_live_` is gone, and the edge after an AWS or Google key with it: the screen shows a key
  run into a label or a piece of styling, and the whole key was then shown. Measured, not decided
  by prefix: the edge stays only where a realistic near miss matches without it, each pinned by a
  case that stays (`risk-…` for `sk-`, `pallbearer` for `Bearer`, `benchmark_test_…` and
  `task_test_…` for the `_test_` payment keys); every glued form has a case that goes. That made
  the order matter the other way: a run inside a key's body can now look like an AWS or Google key,
  and a redactor run before the key's own left a placeholder in the body that ended the key's
  match, so the rest of the body was shown. The key rules now come first, and the key block is two
  rules: `private-key-block` takes a block from its header to its end line, and `private-key-cut`
  one cut off where the window ends, taking only whole words of base64, each ending at a space, a
  line break or the end of the text, so it cannot take a later secret's name or prefix (the
  `token` of `token: …`, the `sk` of `sk-…`) and keeps the line break after the key. A header-less
  body's last, shorter line, which stayed when no end line followed it, goes with
  `private-key-lines` when it is a whole line that looks like base64 (a digit, `+`, `/`, padding,
  or a small letter before a capital), and so does a shorter line between two runs of full lines;
  a word on its own line after the key (`end`, `Done`) stays. Its end is found without a lookahead,
  which runs in the backtracking engine (it took minutes on the hostile text): the line break after
  the line is kept by the replacement.)* *(Amended 2026-10-08, owner: the rules have no order. A
  review found that the order above let `private-key-cut` take the name of a later secret written
  with spaces (`password = …`, `token = …`, a quoted value, a bare `Bearer`), and `private-key-body`
  the leading letters of the line after a body (a token's prefix, a name), so that secret's own
  redactor no longer found it and its value was shown. Fixing that by moving rules again only moves
  the hazard to another pair, so every redactor now looks at the text as read, never at another's
  result (`privacy::find`): everything any match takes goes, and one marker stands for each run of
  matches that overlap or meet (`runs`, `taken`). A match takes itself without what its
  replacement's template copies around the placeholder at its ends (a captured `token=`, the `@`
  after an address password). No redactor can hide a secret from another any more: a key rule may
  still take a later plain word (a name), which only hides more, and the secret's own redactor finds
  its value in the text as read. `private-key-body`'s optional last line, which took the next line's
  leading letters, is deleted: `private-key-lines` takes a body's last, shorter line itself. Two
  secrets that meet now leave one marker where the redaction wrote two. An engine failure takes
  everything after the failing rule's last match, as before.)* *(Amended 2026-10-08, later, owner:
  with no order, the limits the key rules kept for the old order only showed key text, and they are
  gone. `private-key-cut` takes every word of base64 after a cut header, up to the first character
  that is neither base64 nor space: whole words ending at a space let a key whose last or only word
  touches punctuation (an escaped JSON value, a preview ending in `…`, a closing quote) show its
  body. A body's last line goes when it is one word of base64 that ends its line or runs into
  punctuation, with or without a digit or symbol: the owner chose this over taking the first word
  of the next line whatever follows it, and over showing such a last line. A lone word on the line
  after two or more full lines of base64 (`Done`) goes with it; a line that goes on with more words
  stays. `private-key-body` takes that line again in the same shape, so a body whose lines are a
  blank line apart loses it too. One redactor's matches never overlap each other, so one match may
  not run over the start of the next secret of its kind: a token stops where another of its kind
  glued to it begins (`ghp_`, `npm_`, `hf_`, `whsec_`, the payment keys), a JSON web token's last two
  parts go alone, as a token glued to the one before leaves them, and `named-value-up-to-a-name`
  ends a value where another secret name given a value begins inside it
  (`token=<value>,password: <value>`), while `named-value` still takes the whole run, as a value
  may hold such a name. A document's text whose first secret began in the text before it now marks
  where it was taken out, as a screen read does.)* *(Amended 2026-10-08, later still, owner: a
  match that keeps the line break it ends at (a carriage return, U+2028, U+2029) leaves that break
  to the next search, which resumes where the match's taken part ends, so a key's lines right after
  another's are still found. `private-key-body` tries a last line running into punctuation before
  one that ends its line, as the first branch that matches wins. A bearer token glued to another
  goes whole, as does a run of glued test payment keys. A document whose middle is empty marks
  nothing, and a `[hidden for privacy]` block stands apart from the text beside it, so a name given
  a value next to it never takes part of the marker. The owner accepted one limit: an `sk-` key, a
  `Bearer` token or a `_test_` payment key glued to the word before it, in one piece or in a styled
  piece the screen shows glued (a link, a bold run), stays shown, because those three kinds keep a
  word edge each near miss forces (`risk-assessment-template-v2`, `pallbearer`,
  `benchmark_test_…`). The kept edges and the near misses the dropped ones now take are tracked for
  a later decision in the issue tracker.)* *(Amended 2026-10-08, round 13: a rule whose first part
  is optional, or whose length is fixed, may still not end inside a secret of its kind. A JSON web
  token right after a `.` goes whole (its last part may follow a third `eyJ` part), and an AWS or
  Google key goes whole after a near miss with its own prefix glued before it (the match runs over
  such near misses and keeps its fixed end, so a word glued after the key still stays). A key's
  first body line goes after any character that is not base64, kept with the blanks after it, as a
  label piece the screen shows touching the body (`Key:`) is read glued to it; only a base64 word of
  40 or more characters after punctuation, followed by full base64 lines, newly goes with it. A
  `[hidden for privacy]` marker that starts or ends a block (a link whose first or last part was
  left out) stands apart on that side. The owner set the gate for this work on 2026-10-08: no worse
  than `main`, and no bug in what it changed; a key body quoted or commented line by line, or in a
  tmux pane beside another, is shown on `main` too and is tracked in the issue tracker.)*
- *(Amended 2026-10-08, the structured redactors, owner: "the same representation for everything,
  same structural function with just the list of things to look for… simple is king".)* A redactor
  is no longer a regular expression. Each is data for one of a few kinds (`token`, `privateKey`,
  `keyLines`, `jsonWebToken`, `addressPassword`, `namedValue`, `entropy`) in `redactors.json`, read
  and checked once (`privacy/definitions.rs`), and one scanner applies them all (`privacy/scan.rs`):
  every redactor reads the text as read, every place a prefix, label or header occurs is looked at
  on its own, and everything any of them takes goes, one marker for each run that overlaps or
  meets. Every scan goes forward through the text, reading each character a bounded number of
  times (the places found are sorted once), so there is no engine to give up: fancy-regex, the rule
  compiler, the engine-failure path (which took everything after a failing rule's last match) and
  its tests are deleted. Case-blind names and prefixes compare the text case-folded once (Unicode
  simple case folding), and so does a case-blind token's body (a Kelvin sign or a long s folds to a
  letter it may hold); its least length counts characters. The kept word edge (an `sk-` key, a `Bearer` token, a `_test_` payment key
  glued to the word before it stays shown) holds where the screen shows that word and the key in
  one piece; a piece the screen shows on its own (a block, a styled run; `privacy::taken_with_edges`)
  gives its first character an edge, and a prefix glued to text another redactor takes goes with it
  (a key glued to a key), however short what follows it is, whatever the pieces are: an edge only
  adds a find, never drops one. An edge only lets a find start; it never ends one. Only a cut
  between two runs the screen shows is an edge: a field's text around what it shows (its hidden runs
  in a row, heading or link) starts no piece, so a word the field shows from part-way through starts
  no key there. An internationalized domain name's label (`xn--`, whatever its case, through its
  letters, digits and hyphens) at the start of a part is a name, not a random word: main showed
  such hosts, and the bar for the random-word rule is no ordinary address hidden. Only the label is
  spared; what follows it in the part (a path after the host) is judged as any part is. For the same
  bar a number of three or more digits counts as word-like when a word is judged (a media file's
  `3840x2160_60fps_yuv420p10le`, in a path or an address, stays), but cuts no word, so an id's
  leading digits and `sha512-` still go with it. Measured on uniform random words, the share caught
  drops from 92.7% to 92.0% at 24 characters of letters, digits, `-` and `_` (and from 39.5% to
  28.8% for small letters and digits only). A name is also built of short pieces (`x264_8bit_60fps`,
  `en-US_es-MX_pt-BR`, `R2_C3_D4`): in a part of four or more pieces between separators, a piece of
  at most five characters counts as word-like when the part is judged. A random word seldom has
  that many separators, so the share caught moves by at most 0.8 points (95.8% to 95.0% for 40
  characters of letters, digits, `-` and `_`; 24 and 64 characters and base64 by 0.3 or less;
  words with no separator not at all). These two counts are part of what a word-like run is, as
  the threes above are, so they are in the code, not the redactor's data. The texts of one line that `privacy::redact` is given (a terminal's connected runs) are
  pieces of one text and give no edge. The owner set three rules with it:
  - **A key's last line.** After two or more full lines of base64 (40 or more characters, after any
    label, quote mark or gutter; whitespace around a line or after its prefix is any whitespace, a
    no-break or an em space too, as the expressions this replaces read it), the first word of base64 on the next line goes, whatever follows
    it (`Done and more` loses `Done`; accepted). The next line is the next one that is not blank:
    after a key's lines and a blank line, a paragraph's first word goes too (owner, 2026-10-08,
    kept as the side that hides more). A word as long as a full line starting the next
    line counts as one, so a key's last full line may go on with other text, and the word runs on
    over padding and base64 alike. When the run stops at a line such a word starts (after a short
    last line, a key's line beside other text), that word goes and ends the key. A run of such lines never goes on past a sentence's end
    (punctuation, then whitespace) after its first line, because a document's text around a field
    starts and ends there (the source window); a test cuts a witness of every redactor there and
    checks the window still takes all the whole text takes inside it. Each line's base64 goes,
    not the text between: on a line after the first, what comes before the base64 up to a blank
    (a module path in `go.sum`, a host in `known_hosts`, a file name in a checksum listing, a
    gutter, a quote mark) stays, unless it is all base64 too; what is glued to the base64 goes
    with it when it holds base64 (`h1:`, the end of a key run into the next), not when it is only a
    mark (a pane's border). A word as long as a full line before it goes from its start, with what
    lies between (a key's line, then a pane's border or a checksum comment and more base64 on the
    same row). Lines that only whitespace parts go as one marker.
  - **An end line with no header.** `-----END … PRIVATE KEY-----` with no header before it takes
    the text back to the start of the read, or to just after the end line before it, through the
    end line: a body read without its header goes whatever comes before it, and other text read
    before the key (another pane, a label) goes too (accepted). Only private-key lines count; a
    certificate's or a signature's end line takes nothing. A header with no end line after it still
    takes the words of base64 after it up to the first other character, each such header on its own.
    A key cut by a window either side keeps none of its body in the window (its own test).
  - **Words that look random.** A run of `[A-Za-z0-9+/_-]` (padding at its end), cut at a `/`, `_`
    or `-` piece that is itself word-like and at each run of hex pieces at least 24 characters long
    (a UUID or a hash in a path: an app's container path `…/Application/<UUID>/MyApp.app` stays),
    goes when a part is at least 24 characters long, holds a
    letter and a digit (a word of letters and `+` with no digit stays, as the tuning below was
    measured; owner, 2026-10-08), is not hex (letters or a `0x` before hex count as hex, so git
    hashes, digests, ids and hex numbers such as an address or a transaction hash stay), has at
    most half of its characters in word-like runs (a capital and three or more small letters,
    three or more small letters, three or more capitals not followed by a small one), and carries
    at least 3.5 bits of Shannon entropy per character. A piece the screen shows on its own inside
    a word (a link or a block glued to a label beside it) is looked at as a word too: a find more,
    never one less. Every threshold is data in its
    redactor (what a word-like run is, is code). It was tuned on every word of 24 or more characters in our own sources (benign) against
    2,000 random keys per alphabet at 24, 40 and 64 characters (recall). Entropy alone does not
    separate them (at 24 characters random base64 averages 3.86 bits; identifiers and paths reach
    4.0–4.4), so the word-like share does the separating:

    | Word share at most | Benign words taken | base64 24/40/64 | alphanumeric 24/40/64 | URL-safe 24/40/64 |
    |---|---|---|---|---|
    | 0.45 | 41 | .81/.90/.91 | .82/.92/.94 | .77/.83/.87 |
    | 0.50 | 44 | .89/.94/.95 | .92/.95/.98 | .85/.87/.88 |
    | 0.55 | 46 | .92/.94/.96 | .94/.97/.99 | .86/.91/.89 |

    At 0.5 every benign word taken looks random itself (base64 test blobs, token fixtures, price
    ids, publishable keys); no ordinary path, branch name, dated tag, identifier, UUID, git hash or
    `package@version` goes. A random id inside an address does go, as it is random by nature: a
    shared document's or file's id, a playlist id, an OAuth client id, a message id, an `sha512-`
    integrity value, a `data:` address's payload (owner, 2026-10-08: keep hiding them; sparing words
    inside addresses would spare keys pasted into one). A key of small letters and digits only is
    taken about one time in five. Each of the three owner decisions has its shared cases. Cutting
    at hex runs changed none of 32,000 random keys' results.
    *(Owner, 2026-10-09: how this rule is judged.)* Telling a random word from a name is a guess,
    and every name a review builds can be met by another, so the rule is judged by what it measures,
    not by whether a counterexample can be built: the share of random words caught and the benign
    words taken in the tables here. A realistic, common name it hides (one people meet in a path,
    an address or a file name) is a defect and gets a case; a name built to defeat it is not.
    *(Owner, 2026-10-09: random ids in paths.)* A random id a system puts in a path goes like one
    in an address: a Mac's per-user temporary folder (`/var/folders/<xx>/<id>/T/`, about a third
    of them), a Nix store hash (about a quarter), a package manager's hashed folder suffix. It is
    random by nature and tells nothing useful; the rule cannot tell it from a key without special
    cases for paths, which `main`'s rules did not need as they never hid such words. Both have
    cases.

  Checked against `main` and the regular-expression redactors this replaces, over the shared cases,
  66,000 generated glued and paired secrets, 2,762 screen reads, and a second generated set of
  217,000 glued tokens and key lines: no key character `main` takes is shown. The gate counts key
  characters, not blanks (owner, 2026-10-08: "that gate is artificial … something reasonable and
  robust"): whitespace `main`'s expressions swallowed beside a key (a tab indenting key lines, a line
  break after a cut-off key, a blank between two chained `Bearer` tokens) stays as the screen shows
  it, as do the labels, gutters and quote marks between key lines, and so does a short word ending in padding at the start of a text's first line before a key's
  base64 on that line (`abc=` before it), which holds no key character. An end line with no header
  takes the blanks before the key's body back to where it starts. The regular expressions it
  replaces also took a chain of `Bearer` words as one find; the scanner shows what that chain held
  that is no token (a body shorter than a token's least length) and a token after a `Bearer` glued
  to a word, the kept word edge above. Expectations the owner's rules changed are renamed in the
  shared cases to say what now goes.
  A piece of the screen whose text starts or ends with a line break is laid out on its own line,
  whatever the box of that break says (a box at the end of the line before must not glue a key's
  short last line to its full lines with a space). A piece laid out against `Bearer` with no gap
  reads as the screen shows it, `Bearer` glued to the body: a body of key lines that look random
  goes as such, while a body built of one repeated group (`QUJD…`) stays, as `main` showed it only
  by inventing a space between the two pieces (judgement call, 2026-10-09).
- What a replacement keeps of its match is told by comparing the two texts. A secret that itself
  ends in `]`, with a boundary between two texts just before that `]`, leaves the placeholder's
  last character in the second text. Nothing of the secret is kept. *(Superseded 2026-10-08: what
  a match keeps is what its template copies around the placeholder at the match's ends, never a
  comparison of the texts, so a secret ending in `]` keeps nothing.)*
- Edit's refusal asks the backend for no rewrite. When several tools are offered, the pick of the
  tool has already been asked, with the redacted screen.
- A correction of a word into something secret-looking is not learned: the field is redacted before
  the core compares it. When the heard word is close to the placeholder's own (`rejected`), the
  word `redacted` is learned in its place.
- A table row is one text, its cells joined by ` | `: a name in one cell and its value in the next
  stay, as a label with no `=` or `:` above its value does.
- The Windows and Linux helpers redact once they add their emitter and run the shared cases.

