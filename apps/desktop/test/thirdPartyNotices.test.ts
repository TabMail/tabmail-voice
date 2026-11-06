// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { noticeInputs, recordedInputs, render, type NoticeInputs } from "../scripts/third-party-notices.mts";

const root = join(__dirname, "..");
const inputs: NoticeInputs = { coreLock: "a".repeat(64), config: "b".repeat(64), keyring: "1.0.0", nlohmann: "3.0.0", rust: "1.0.0" };

describe("third-party notices", () => {
  /** A changed Cargo.lock, cargo-about configuration, keyring version, nlohmann/json or Rust toolchain fails here
   * until `scripts/third-party-notices.mts` is run again, so the shipped notices never fall behind. */
  test("the shipped notices were generated from the tree's current inputs", () => {
    const notices = readFileSync(join(root, "../../THIRD_PARTY_NOTICES.md"), "utf8");
    expect(recordedInputs(notices)).toEqual(noticeInputs(root));
  });

  test("the shipped notices cover the core's crates, keyring's and the C code", () => {
    const notices = readFileSync(join(root, "../../THIRD_PARTY_NOTICES.md"), "utf8");
    const lock = readFileSync(join(root, "native/shared/rust/Cargo.lock"), "utf8");
    const core = [...lock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"\nsource = /gm)].map(([, name, version]) => `${name} ${version}`);
    const named = new Set([...notices.matchAll(/^Used by: (.*)$/gm)].flatMap(([, list]) => (list ?? "").split(", ")));
    expect(core.length).toBeGreaterThan(40);
    // Every crate the core locks, at its locked version.
    for (const crate of core) expect(named.has(crate), crate).toBe(true);
    // The other components, each named over a licence text (the file's header names some of them too).
    const { keyring, nlohmann, rust } = noticeInputs(root);
    for (const component of [`napi-keyring (@napi-rs/keyring) ${keyring}`, `nlohmann/json ${nlohmann}`, `Rust standard library ${rust} (MIT OR Apache-2.0)`]) {
      expect(named.has(component), component).toBe(true);
    }
    for (const prefix of ["keyring-core ", "libdbus (bundled in libdbus-sys "]) {
      expect([...named].some((component) => component.startsWith(prefix)), prefix).toBe(true);
    }
    // The Rust standard library's two licences, MIT and Apache 2.0, each its own section.
    expect([...notices.matchAll(/^Used by: .*Rust standard library /gm)]).toHaveLength(2);
  });

  /** cargo-about fills in a licence's template where a crate ships no licence file, with no
   * copyright holder: such a crate needs its real licence file in `native/third-party-notices.toml`. */
  test("every licence text is a real one, not a template with no copyright holder", () => {
    const notices = readFileSync(join(root, "../../THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).not.toMatch(/Copyright \(c\) <year> <copyright holders>/);
  });

  test("one section a distinct licence text, its components sorted and named once", () => {
    const text = render(inputs, [
      { license: "MIT License", text: "Copyright A\n", usedBy: ["b 1"] },
      { license: "MIT License", text: "Copyright A", usedBy: ["a 1", "b 1"] },
      { license: "MIT License", text: "Copyright B", usedBy: ["c 1"] },
      { license: "Apache License 2.0", text: "Apache", usedBy: ["d 1"] },
    ]);
    expect(text.match(/^## /gm)).toHaveLength(3);
    expect(text.indexOf("## Apache License 2.0")).toBeLessThan(text.indexOf("## MIT License"));
    expect(text).toContain("Used by: a 1, b 1\n\n````text\nCopyright A\n````");
    expect(text).toContain("Used by: c 1\n\n````text\nCopyright B\n````");
    expect(recordedInputs(text)).toEqual(inputs);
  });

  test("a licence text with Windows line endings is the same text with Unix ones", () => {
    const text = render(inputs, [
      { license: "Apache License 2.0", text: "Apache\r\nLicense\r\n", usedBy: ["a 1"] },
      { license: "Apache License 2.0", text: "Apache\nLicense\n", usedBy: ["b 1"] },
    ]);
    expect(text.match(/^## /gm)).toHaveLength(1);
    expect(text).toContain("Used by: a 1, b 1\n\n````text\nApache\nLicense\n````");
    expect(text).not.toContain("\r");
  });

  test("the shipped file has no two sections with one licence and text, and no Windows line endings", () => {
    const notices = readFileSync(join(root, "../../THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).not.toContain("\r");
    const sections = notices.split("\n## ").slice(1).map((section) => section.replace(/^(.*)\n\nUsed by: .*\n/, "$1\n"));
    expect(sections.length).toBeGreaterThan(10);
    expect(new Set(sections).size).toBe(sections.length);
  });

  test("a file that records no inputs reads as none", () => {
    expect(recordedInputs("# Third-party notices\n")).toBeNull();
  });
});
