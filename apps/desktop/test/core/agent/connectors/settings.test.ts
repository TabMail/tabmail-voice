// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { type ConnectorTool, ToolArgumentError } from "../../../../src/core/agent/connectors/contract.js";
import { ChangeSettingTool, eventDurationLabel, eventDurationSetting, isEventDuration, type SettingsWriter, settingsConnector } from "../../../../src/core/agent/connectors/settings.js";
import * as config from "../../../../src/core/config.js";
import { toolSettings } from "../../../support/stubs.js";

/** Agent mode changing TabMail Voice's own settings (`change_setting`), as the Thunderbird add-on and
 * the iOS app do: today the default event duration, through a fake writer. */

const signal = new AbortController().signal;

/** Records every duration it is given, and answers `saves`. */
class FakeSettings implements SettingsWriter {
  readonly written: number[] = [];
  saves = true;

  setEventDuration(minutes: number): boolean {
    this.written.push(minutes);
    return this.saves;
  }
}

/** `change_setting` as the controller runs it: through the connector contract. */
function tool(settings = new FakeSettings()): { tool: ConnectorTool; settings: FakeSettings } {
  return { tool: new ChangeSettingTool(settings), settings };
}

describe("change_setting", () => {
  test("is the Settings connector's one tool, and asks nothing first", () => {
    const settings = new FakeSettings();
    const tools = settingsConnector.tools({ settings });
    expect(tools.map((each) => each.name)).toEqual(["change_setting"]);
    expect(tools[0]?.connector).toBe("settings");
    expect(settingsConnector.platforms).toEqual(["darwin", "win32", "linux"]);
    expect(tool().tool.confirmation({ setting: eventDurationSetting, value: 30 }, signal, toolSettings)).toBeNull();
  });

  test("sets the default event duration, and says it applies from the next request", async () => {
    const { tool: change, settings } = tool();
    await expect(change.run({ setting: eventDurationSetting, value: 30 }, signal, toolSettings)).resolves.toBe(
      "The default event duration is now 30 min, from the next request: a new event with no end time lasts that long.",
    );
    expect(settings.written).toEqual([30]);
  });

  test.each([
    ["90", 90],
    [" 120 ", 120],
  ])("takes the value %j written as a number", async (value, minutes) => {
    const { tool: change, settings } = tool();
    await expect(change.run({ setting: eventDurationSetting, value }, signal, toolSettings)).resolves.toContain(eventDurationLabel(minutes));
    expect(settings.written).toEqual([minutes]);
  });

  test("a missing setting is refused, and nothing is written", async () => {
    const { tool: change, settings } = tool();
    await expect(change.run({ value: 30 }, signal, toolSettings)).rejects.toThrow(new ToolArgumentError("setting is required."));
    expect(settings.written).toEqual([]);
  });

  test("a setting Voice doesn't have is refused, naming the one it has", async () => {
    const { tool: change, settings } = tool();
    const refusal = change.run({ setting: "general.theme", value: 30 }, signal, toolSettings);
    await expect(refusal).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(refusal).rejects.toThrow(`TabMail Voice has no setting general.theme; it has ${eventDurationSetting}.`);
    expect(settings.written).toEqual([]);
  });

  test.each([undefined, null, "", "  ", "an hour", true, 0, config.eventDurationMin - 1, config.eventDurationMax + 1, 30.5, "30.5", Number.NaN, Number.POSITIVE_INFINITY])(
    "the value %j is refused, and nothing is written",
    async (value) => {
      const { tool: change, settings } = tool();
      const refusal = change.run({ setting: eventDurationSetting, value }, signal, toolSettings);
      await expect(refusal).rejects.toBeInstanceOf(ToolArgumentError);
      await expect(refusal).rejects.toThrow(`value must be a whole number of minutes from ${config.eventDurationMin} to ${config.eventDurationMax}.`);
      expect(settings.written).toEqual([]);
    },
  );

  /** The range `change_setting` advertises, written out: 5 to 720 minutes. */
  test.each([
    [4, false],
    [5, true],
    [720, true],
    [721, false],
  ])("the value %i is %s taken", async (minutes, taken) => {
    const { tool: change, settings } = tool();
    const run = change.run({ setting: eventDurationSetting, value: minutes }, signal, toolSettings);
    if (taken) await expect(run).resolves.toContain(eventDurationLabel(minutes));
    else await expect(run).rejects.toThrow("value must be a whole number of minutes from 5 to 720.");
    expect(settings.written).toEqual(taken ? [minutes] : []);
  });

  test("the range's ends are taken", async () => {
    const { tool: change, settings } = tool();
    await change.run({ setting: eventDurationSetting, value: config.eventDurationMin }, signal, toolSettings);
    await change.run({ setting: eventDurationSetting, value: config.eventDurationMax }, signal, toolSettings);
    expect(settings.written).toEqual([config.eventDurationMin, config.eventDurationMax]);
  });

  test("a value Settings couldn't save is reported, not claimed", async () => {
    const settings = new FakeSettings();
    settings.saves = false;
    const refusal = tool(settings).tool.run({ setting: eventDurationSetting, value: 30 }, signal, toolSettings);
    await expect(refusal).rejects.toThrow("The setting couldn't be saved. Nothing was changed.");
    await expect(refusal).rejects.not.toBeInstanceOf(ToolArgumentError);
  });
});

describe("event durations", () => {
  test.each([
    [5, "5 min"],
    [45, "45 min"],
    [60, "1 hour"],
    [90, "1h 30m"],
    [120, "2 hours"],
    [125, "2h 5m"],
    [720, "12 hours"],
  ])("%i minutes reads %s", (minutes, label) => {
    expect(eventDurationLabel(minutes)).toBe(label);
  });

  test("every choice and the default are durations, within the range", () => {
    expect(config.eventDurationChoices).toEqual([15, 30, 45, 60, 90, 120]);
    expect(config.eventDurationChoices).toContain(config.eventDurationDefault);
    for (const minutes of config.eventDurationChoices) expect(isEventDuration(minutes)).toBe(true);
    expect(isEventDuration(config.eventDurationMin)).toBe(true);
    expect(isEventDuration(config.eventDurationMax)).toBe(true);
    expect(isEventDuration(config.eventDurationMin - 1)).toBe(false);
    expect(isEventDuration(config.eventDurationMax + 1)).toBe(false);
    expect(isEventDuration(30.5)).toBe(false);
  });
});
