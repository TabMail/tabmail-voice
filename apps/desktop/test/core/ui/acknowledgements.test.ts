// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { acknowledgements } from "../../../src/core/ui/acknowledgements.js";

const desktop = join(__dirname, "../../..");

/** Which acknowledgement credits each package the app ships and each crate its shared core links. */
const creditedAs: Record<string, string> = {
  "@jitl/quickjs-wasmfile-release-sync": "QuickJS",
  "@napi-rs/keyring": "keyring-node",
  "abort-controller": "abort-controller",
  "electron-updater": "electron-updater",
  "jsonc-parser": "jsonc-parser",
  "pdfjs-dist": "PDF.js",
  "quickjs-emscripten-core": "quickjs-emscripten",
  react: "React",
  "react-dom": "React",
  "web-streams-polyfill": "web-streams-polyfill",
  serde_json: "serde_json",
  fst: "fst",
  icu_casemap: "ICU4X",
  "unicode-normalization": "unicode-rs",
  "unicode-script": "unicode-rs",
  "unicode-segmentation": "unicode-rs",
  "unicode-width": "unicode-rs",
  url: "rust-url",
};

/** The crate names under the shared core's `[dependencies]`. */
function coreCrates(): string[] {
  const manifest = readFileSync(join(desktop, "native/shared/rust/Cargo.toml"), "utf8");
  const section = manifest.split(/^\[dependencies\]$/m)[1]?.split(/^\[/m)[0] ?? "";
  return [...section.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1] ?? "");
}

describe("acknowledgements", () => {
  /** A package or crate added to what Voice ships is credited, or this fails. */
  test("every package the app ships and every crate its shared core links is credited", () => {
    const { dependencies } = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const shipped = [...Object.keys(dependencies), ...coreCrates()];
    expect(coreCrates()).toContain("fst");
    const names = acknowledgements.map(({ name }) => name);
    for (const dependency of shipped) expect(names, dependency).toContain(creditedAs[dependency]);
  });

  test("each is named once, with a licence and a web page", () => {
    const names = acknowledgements.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const { name, license, url } of acknowledgements) {
      expect(license, name).not.toBe("");
      expect(new URL(url).protocol, name).toBe("https:");
    }
  });

  /** The repository's third-party notice says at length what Settings lists. */
  test("the third-party notice names each of them", () => {
    const notice = readFileSync(join(desktop, "../../THIRD_PARTY_LICENSES.md"), "utf8");
    for (const { name, url } of acknowledgements) {
      expect(notice, name).toContain(`## ${name}`);
      expect(notice, name).toContain(url);
    }
  });
});
