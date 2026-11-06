// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** An open-source work TabMail Voice ships or is built from, as Settings' Acknowledgements lists it
 * (as TabMail on iOS does): its name, its licence, where it lives, and what of it Voice uses when the
 * name alone doesn't say. */
export interface Acknowledgement {
  name: string;
  license: string;
  url: string;
  note?: string;
}

/** What Settings' Acknowledgements says above the list. */
export const acknowledgementsIntro =
  "TabMail Voice is built with the help of these open source projects and data. We're grateful to their authors and contributors.";

/** Where the app's own source is, said under the list (the MPL 2.0 asks that its users can find it). */
export const sourceLine = { text: "TabMail Voice is open source under the Mozilla Public License 2.0.", link: "Source code", url: "https://github.com/TabMail/tabmail-voice" };

/** Every work Voice ships or is built from, by group: the app, its shared core, the helpers, the
 * memory helper, the screen-term word list, and the rest as one entry. `THIRD_PARTY_LICENSES.md` at
 * the repository's root says the same at length, with copyrights and the licence texts. */
export const acknowledgements: readonly Acknowledgement[] = [
  // The app.
  { name: "Electron", license: "MIT License", url: "https://www.electronjs.org" },
  { name: "Chromium", license: "BSD 3-Clause License and its components' licences", url: "https://www.chromium.org", note: "Its components and their licences, FFmpeg (LGPL 2.1) among them, are listed in LICENSES.chromium.html" },
  { name: "React", license: "MIT License", url: "https://react.dev", note: "React and React DOM" },
  { name: "PDF.js", license: "Apache License 2.0", url: "https://mozilla.github.io/pdf.js", note: "With Adobe's CMaps (BSD 3-Clause License)" },
  { name: "QuickJS", license: "MIT License", url: "https://bellard.org/quickjs/" },
  { name: "quickjs-emscripten", license: "MIT License", url: "https://github.com/justjake/quickjs-emscripten" },
  { name: "keyring-node", license: "MIT License", url: "https://github.com/Brooooooklyn/keyring-node" },
  { name: "libdbus", license: "Academic Free License 2.1", url: "https://www.freedesktop.org/wiki/Software/dbus", note: "Built into keyring-node on Linux" },
  { name: "electron-updater", license: "MIT License", url: "https://github.com/electron-userland/electron-builder", note: "With builder-util-runtime" },
  { name: "jsonc-parser", license: "MIT License", url: "https://github.com/microsoft/node-jsonc-parser" },
  { name: "abort-controller", license: "MIT License", url: "https://github.com/mysticatea/abort-controller" },
  { name: "web-streams-polyfill", license: "MIT License", url: "https://github.com/MattiasBuelens/web-streams-polyfill" },
  // The helpers' shared core.
  { name: "fst", license: "MIT License or Unlicense", url: "https://github.com/BurntSushi/fst" },
  { name: "ICU4X", license: "Unicode License v3", url: "https://github.com/unicode-org/icu4x" },
  { name: "serde_json", license: "MIT License or Apache License 2.0", url: "https://github.com/serde-rs/json" },
  { name: "unicode-rs", license: "MIT License or Apache License 2.0", url: "https://github.com/unicode-rs", note: "Normalization, scripts, segmentation and widths" },
  { name: "rust-url", license: "MIT License or Apache License 2.0", url: "https://github.com/servo/rust-url" },
  // The Windows and Linux helpers.
  { name: "nlohmann/json", license: "MIT License", url: "https://github.com/nlohmann/json" },
  { name: "IAccessible2", license: "BSD 3-Clause License", url: "https://github.com/LinuxA11y/IAccessible2" },
  // The memory helper.
  { name: "SQLite", license: "Public domain", url: "https://sqlite.org" },
  { name: "rusqlite", license: "MIT License", url: "https://github.com/rusqlite/rusqlite" },
  { name: "sqlite-vec", license: "MIT License or Apache License 2.0", url: "https://github.com/asg017/sqlite-vec" },
  { name: "Candle", license: "MIT License or Apache License 2.0", url: "https://github.com/huggingface/candle" },
  { name: "Tokenizers", license: "Apache License 2.0", url: "https://github.com/huggingface/tokenizers" },
  { name: "safetensors", license: "Apache License 2.0", url: "https://github.com/huggingface/safetensors" },
  { name: "Oniguruma", license: "BSD 2-Clause License", url: "https://github.com/kkos/oniguruma" },
  { name: "all-MiniLM-L6-v2", license: "Apache License 2.0", url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2", note: "Downloaded when memory is first used" },
  { name: "ed25519-dalek", license: "BSD 3-Clause License", url: "https://github.com/dalek-cryptography/curve25519-dalek", note: "With curve25519-dalek and subtle" },
  { name: "ureq", license: "MIT License or Apache License 2.0", url: "https://github.com/algesten/ureq" },
  { name: "rustls", license: "Apache License 2.0, ISC License or MIT License", url: "https://github.com/rustls/rustls" },
  { name: "ring", license: "Apache License 2.0 and ISC License", url: "https://github.com/briansmith/ring" },
  { name: "webpki-roots", license: "CDLA Permissive 2.0", url: "https://github.com/rustls/webpki-roots", note: "Mozilla's root certificates" },
  { name: "RustCrypto hashes", license: "MIT License or Apache License 2.0", url: "https://github.com/RustCrypto/hashes" },
  { name: "chrono", license: "MIT License or Apache License 2.0", url: "https://github.com/chronotope/chrono" },
  { name: "flexi_logger", license: "MIT License or Apache License 2.0", url: "https://github.com/emabee/flexi_logger" },
  // The screen-term word list.
  {
    name: "FrequencyWords",
    license: "CC BY-SA 4.0",
    url: "https://github.com/hermitdave/FrequencyWords",
    note: "Hermit Dave's word counts of OpenSubtitles 2018, adapted into the word list screen terms are judged by, itself CC BY-SA 4.0",
  },
  { name: "OpenSubtitles 2018", license: "The subtitles FrequencyWords counted", url: "https://www.opensubtitles.org", note: "Through OPUS: P. Lison and J. Tiedemann, LREC 2016" },
  { name: "wordfreq", license: "Apache License 2.0 (code), CC BY-SA 4.0 (data)", url: "https://github.com/rspeer/wordfreq", note: "Its word normalization and letter tables" },
  { name: "OpenCC", license: "Apache License 2.0", url: "https://github.com/BYVoid/OpenCC", note: "Traditional to Simplified Chinese, through wordfreq's table" },
  { name: "Unicode CLDR", license: "Unicode License v3", url: "https://cldr.unicode.org", note: "The letters each language is written in" },
  // The rest.
  {
    name: "Other open-source components",
    license: "MIT, Apache 2.0, ISC, BSD, Zlib, Unlicense, Unicode v3, CDLA Permissive 2.0, Blue Oak 1.0.0 and Python 2.0 licences",
    url: "https://github.com/TabMail/tabmail-voice/blob/main/THIRD_PARTY_NOTICES.md",
    note: "The npm packages and Rust crates the projects above build on",
  },
];
