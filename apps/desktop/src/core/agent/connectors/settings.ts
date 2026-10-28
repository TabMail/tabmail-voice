// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { unsavedBecauseOf } from "../../ui/fileProblems.js";
import type { StoreProblem } from "../../util/keyValueStore.js";
import { Arguments, type ConnectorServices, type ConnectorTool, defineConnector, ToolArgumentError } from "./contract.js";

/** The settings agent mode can change, as Settings stores them. */
export interface SettingsWriter {
  /** Stores how long a new event lasts (minutes); false when it is out of range or couldn't be saved. */
  setEventDuration(minutes: number): boolean;
  /** Why the settings file couldn't be read at launch, until it is fixed or the user resets it: nothing
   * is saved to it meanwhile. */
  readonly fileProblem?: StoreProblem;
}

/** The key `change_setting` names the default event duration by, as Thunderbird's and iOS's. */
export const eventDurationSetting = "calendar.default_event_duration_minutes";

/** Whether `minutes` is a duration a new event can default to: whole minutes from
 * `config.eventDurationMin` to `config.eventDurationMax`. */
export function isEventDuration(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= config.eventDurationMin && minutes <= config.eventDurationMax;
}

/** A duration as Settings' list says it, as Thunderbird's does: "45 min", "1 hour", "1h 30m", "2 hours". */
export function eventDurationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours}h ${rest}m`;
}

export const settingsConnector = defineConnector({
  id: "settings",
  order: 90,
  platforms: ["darwin", "win32", "linux"],
  displayName: "Settings",
  settingsDescription: "Changes TabMail Voice’s settings when you ask, such as how long a new event lasts.",
  tools: ({ settings }: Pick<ConnectorServices, "settings">): ConnectorTool[] => [new ChangeSettingTool(settings)],
});

/** Changes one of TabMail Voice's settings (`change_setting`), as the Thunderbird add-on and the iOS
 * app do; today the default event duration. A setting is neither sent nor created, so nothing is asked
 * first. It applies from the next request: a request reads its settings once, as it starts. */
export class ChangeSettingTool implements ConnectorTool {
  readonly name = "change_setting";
  readonly connector = "settings";
  readonly progressLabel = "Changing a setting";

  constructor(private readonly settings: SettingsWriter) {}

  confirmation(): null {
    return null;
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const setting = Arguments.text(args, "setting");
    if (setting === null) throw ToolArgumentError.missing("setting");
    if (setting !== eventDurationSetting) throw new ToolArgumentError(`TabMail Voice has no setting ${setting}; it has ${eventDurationSetting}.`);
    const value = args.value;
    const minutes = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!isEventDuration(minutes)) throw new ToolArgumentError(`value must be a whole number of minutes from ${config.eventDurationMin} to ${config.eventDurationMax}.`);
    if (!this.settings.setEventDuration(minutes)) throw new Error(this.settings.fileProblem === undefined ? "The setting couldn't be saved. Nothing was changed." : unsavedBecauseOf("settings"));
    return `The default event duration is now ${eventDurationLabel(minutes)}, from the next request: a new event with no end time lasts that long.`;
  }
}
