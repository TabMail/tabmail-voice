// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/** The real `install-update`, run in `verify` mode as this user against packages built here: it needs
 * Debian's tools, so it runs on Linux (the packaged tests run it in the Ubuntu VM). `install` mode,
 * as root, is exercised by the installed-upgrade test (ADR-DESK-050). */
const hasDebianTools = process.platform === "linux" && spawnSync("dpkg", ["--version"]).status === 0;

describe.skipIf(!hasDebianTools)("install-update (ADR-DESK-050)", () => {
  // Made before the tests, and only where they run: the collection runs on every platform.
  let root = "";
  let script = "";
  let architecture = "";
  let installedVersion: string | null = null;
  const release = generateKeyPairSync("ed25519");
  const stranger = generateKeyPairSync("ed25519");
  const installKey = () => writeFileSync(join(root, "linux", "update-keys", "release.pem"), release.publicKey.export({ type: "spki", format: "pem" }));
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "voice-install-update-"));
    script = join(root, "linux", "install-update");
    mkdirSync(join(root, "linux", "update-keys"), { recursive: true });
    copyFileSync(join(__dirname, "../../../../resources/linux/install-update"), script);
    execFileSync("chmod", ["0755", script]);
    installKey();
    architecture = execFileSync("dpkg", ["--print-architecture"], { encoding: "utf8" }).trim();
    const installed = spawnSync("dpkg-query", ["-W", "-f", "${Version}", "tabmail-voice"], { encoding: "utf8" });
    installedVersion = installed.status === 0 ? installed.stdout.trim() : null;
    good = deb({ version });
    goodHash = sha512(good);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let packages = 0;
  /** A package as the release builds it, as small as dpkg allows. */
  function deb(fields: { package?: string; version: string; architecture?: string; description?: string }): string {
    const directory = join(root, `package-${++packages}`);
    mkdirSync(join(directory, "DEBIAN"), { recursive: true });
    writeFileSync(join(directory, "DEBIAN", "control"), [
      `Package: ${fields.package ?? "tabmail-voice"}`,
      `Version: ${fields.version}`,
      `Architecture: ${fields.architecture ?? architecture}`,
      "Maintainer: Example <test@example.com>",
      `Description: ${fields.description ?? "test package"}`,
      "",
    ].join("\n"));
    const file = `${directory}.deb`;
    execFileSync("dpkg-deb", ["--build", "--root-owner-group", directory, file], { stdio: "ignore" });
    return file;
  }

  const sha512 = (file: string) => createHash("sha512").update(readFileSync(file)).digest("base64");
  /** The release's signature over what `install-update` checks. */
  function signature(fields: { version: string; sha512: string; architecture?: string; package?: string }, key: KeyObject = release.privateKey): string {
    const message = `TabMail Voice update\npackage: ${fields.package ?? "tabmail-voice"}\narchitecture: ${fields.architecture ?? architecture}\nversion: ${fields.version}\nsha512: ${fields.sha512}\n`;
    return sign(null, Buffer.from(message), key).toString("base64");
  }
  const run = (...args: string[]) => spawnSync(script, args).status;

  const version = "999.0.0";
  let good = "";
  let goodHash = "";

  test("a package signed by a key installed with the app, and newer, passes", () => {
    expect(run("verify", good, version, goodHash, signature({ version, sha512: goodHash }))).toBe(0);
  });

  test.each<[string, () => string[], number]>([
    ["signed by another key", () => ["verify", good, version, goodHash, signature({ version, sha512: goodHash }, stranger.privateKey)], 3],
    ["unsigned", () => ["verify", good, version, goodHash, ""], 3],
    ["with a signature that isn't base64", () => ["verify", good, version, goodHash, "@@@"], 3],
    ["signed for another architecture", () => ["verify", good, version, goodHash, signature({ version, sha512: goodHash, architecture: "s390x" })], 3],
    ["signed for another package", () => ["verify", good, version, goodHash, signature({ version, sha512: goodHash, package: "other" })], 3],
    ["whose bytes aren't the signed ones", () => {
      // Another build of the same version: other bytes.
      const other = deb({ version, description: "another build" });
      const otherHash = sha512(other);
      return ["verify", good, version, otherHash, signature({ version, sha512: otherHash })];
    }, 4],
    ["whose own version isn't the signed one", () => {
      const older = deb({ version: "998.0.0" });
      const hash = sha512(older);
      return ["verify", older, version, hash, signature({ version, sha512: hash })];
    }, 4],
    ["of another package, signed", () => {
      const other = deb({ version, package: "not-voice" });
      const hash = sha512(other);
      return ["verify", other, version, hash, signature({ version, sha512: hash })];
    }, 4],
    ["for another architecture, signed", () => {
      const other = deb({ version, architecture: architecture === "arm64" ? "amd64" : "arm64" });
      const hash = sha512(other);
      return ["verify", other, version, hash, signature({ version, sha512: hash })];
    }, 4],
    ["that isn't there", () => ["verify", join(root, "missing.deb"), version, goodHash, signature({ version, sha512: goodHash })], 4],
    ["with a version that isn't x.y.z", () => ["verify", good, "999.0.0-1", goodHash, signature({ version: "999.0.0-1", sha512: goodHash })], 4],
    ["installed by a user who isn't root", () => ["install", good, version, goodHash, signature({ version, sha512: goodHash })], 2],
    ["asked something else", () => ["remove", good, version, goodHash, signature({ version, sha512: goodHash })], 2],
    ["with arguments missing", () => ["verify", good, version], 2],
  ])("a package %s is refused", (_case, args, code) => {
    expect(run(...args())).toBe(code);
  });

  /** Never an older version, or the same again: the signature can't make a downgrade an update. */
  test("a signed package no newer than the installed version is refused", () => {
    if (installedVersion === null) return; // Nothing installed to be older than.
    const current = installedVersion;
    const same = deb({ version: current });
    const hash = sha512(same);
    expect(run("verify", same, current, hash, signature({ version: current, sha512: hash }))).toBe(5);
  });

  test("with no key installed, nothing passes", () => {
    rmSync(join(root, "linux", "update-keys", "release.pem"));
    try {
      expect(run("verify", good, version, goodHash, signature({ version, sha512: goodHash }))).toBe(3);
    } finally {
      installKey();
    }
  });
});
