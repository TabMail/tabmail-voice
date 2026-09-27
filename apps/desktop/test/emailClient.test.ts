// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EmailClient } from "../src/core/agent/emailClient.js";
import * as config from "../src/core/config.js";
import { Fixtures, nodeProfileFiles } from "./support.js";

const thunderbird = "org.mozilla.thunderbird";
const beta = "org.mozilla.thunderbirdbeta";
const appleMail = "com.apple.mail";
const otherAddon = Fixtures.addon({ id: "other@example.com" });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(profiles: Record<string, unknown>[][]): string {
  const made = Fixtures.thunderbirdFolder(profiles);
  folders.push(made);
  return made;
}

function hasTabMail(directory: string): boolean {
  return EmailClient.hasTabMail(directory, nodeProfileFiles);
}

/** Which email app mail and calendar requests go to: the one chosen in Settings, else the default
 * email app if TabMail's add-on runs in it, else none; none at all while no Thunderbird profile
 * has the add-on. */
describe("EmailClient", () => {
  test("the chosen app wins over the default", () => {
    expect(EmailClient.resolve(beta, thunderbird, true)).toBe(beta);
    expect(EmailClient.resolve(thunderbird, appleMail, true)).toBe(thunderbird);
  });

  test("a default Thunderbird is used when nothing is chosen", () => {
    expect(EmailClient.resolve(null, thunderbird, true)).toBe(thunderbird);
    expect(EmailClient.resolve(null, beta, true)).toBe(beta);
  });

  /** Another default email app gets nothing: the Thunderbird tool is left out. */
  test("an unsupported or missing default means none", () => {
    expect(EmailClient.resolve(null, appleMail, true)).toBeNull();
    expect(EmailClient.resolve(null, null, true)).toBeNull();
  });

  /** Without TabMail's add-on nothing is offered, whether Thunderbird is chosen or the default. */
  test("without the add-on there is no email app", () => {
    expect(EmailClient.resolve(beta, thunderbird, false)).toBeNull();
    expect(EmailClient.resolve(null, thunderbird, false)).toBeNull();
  });

  /** The add-on counts in any profile, not only the first one listed. */
  test("an enabled add-on in any profile counts", () => {
    expect(hasTabMail(folder([[otherAddon], [otherAddon, Fixtures.addon()]]))).toBe(true);
  });

  /** A disabled add-on, or only other add-ons, is no TabMail. */
  test.each([
    [config.tabMailAddonID, true, false],
    [config.tabMailAddonID, false, true],
    ["other@example.com", false, false],
  ])("add-on %s (user disabled %s, app disabled %s) does not count", (id, userDisabled, appDisabled) => {
    expect(hasTabMail(folder([[Fixtures.addon({ id, userDisabled, appDisabled })]]))).toBe(false);
  });

  /** A profile stored outside the Thunderbird folder (`IsRelative=0`) is read at its absolute path. */
  test("an absolute profile path is followed", () => {
    const directory = folder([]);
    const profile = join(directory, "elsewhere/test.profile");
    Fixtures.writeExtensions([Fixtures.addon()], profile);
    writeFileSync(join(directory, "profiles.ini"), `[Profile0]\r\nName=profile-0\r\nIsRelative=0\r\nPath=${profile}\r\n`);
    expect(hasTabMail(directory)).toBe(true);
  });

  /** No Thunderbird folder, or a profile whose `extensions.json` is missing or unreadable, is no
   * TabMail. */
  test("missing or unreadable files mean no add-on", () => {
    expect(hasTabMail(join(tmpdir(), `TabMailVoiceTests-missing-${Date.now()}`))).toBe(false);

    const directory = folder([[Fixtures.addon()], [Fixtures.addon()], [Fixtures.addon()]]);
    unlinkSync(join(directory, "Profiles/test.profile-0/extensions.json"));
    writeFileSync(join(directory, "Profiles/test.profile-1/extensions.json"), "not json");
    writeFileSync(join(directory, "Profiles/test.profile-2/extensions.json"), `{"addons":{"id":"${config.tabMailAddonID}"}}`);
    expect(hasTabMail(directory)).toBe(false);
  });

  test("a folder without profiles.ini has no add-on", () => {
    const directory = join(tmpdir(), `TabMailVoiceTests-empty-${Date.now()}`);
    mkdirSync(directory);
    folders.push(directory);
    expect(hasTabMail(directory)).toBe(false);
  });
});
