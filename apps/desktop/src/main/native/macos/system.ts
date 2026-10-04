// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type CalendarEvent, type EventStore, EventStoreError, type ReminderItem } from "../../../core/agent/connectors/calendar.js";
import { type ContactCard, type ContactStore, ContactStoreError } from "../../../core/agent/connectors/contacts.js";
import { type FileStore, FileStoreError, type FoundItem } from "../../../core/agent/connectors/files.js";
import type { FocusedElement, ThunderbirdSystem } from "../../../core/agent/connectors/thunderbird/relay.js";
import * as config from "../../../core/config.js";
import type { GlobeKeySystem } from "../../../core/hotkey/macos/globeKeyAction.js";
import type { Rect } from "../../../core/ui/overlayGeometry.js";
import type { ScreenExclusions } from "../../../core/dictation/excludedSites.js";
import type { ScreenRead } from "../../../core/dictation/screenContext.js";
import { HelperError, type HelperClient } from "../helperClient.js";
import { keyboardLanguageCode } from "../keyboardLanguage.js";

/** What `voice-macos` does for the app (`MacService` in the helper), typed. */
export class MacSystem {
  constructor(private readonly helper: HelperClient) {}

  /** Pastes `text` into the focused field, then restores the user's clipboard (ADR-DESK-002). Given
   * its dictation's `signal`, the paste waits out a helper restart unless the dictation is canceled
   * first (`HelperClient.request`). */
  async paste(text: string, signal?: AbortSignal): Promise<void> {
    await this.helper.request("insert", { text, restoreDelay: config.clipboardRestoreDelay / 1000 }, config.helperRequestTimeout + config.clipboardRestoreDelay, signal);
  }

  /** The process of the app in front. */
  async frontmostApp(): Promise<number | null> {
    const app = await this.helper.request<{ pid?: unknown } | null>("frontmostApp");
    return typeof app?.pid === "number" ? app.pid : null;
  }

  async keyboardLanguage(): Promise<string | null> {
    const reply = await this.helper.request<{ code?: unknown } | null>("keyboardLanguage");
    return keyboardLanguageCode(reply?.code);
  }

  /** The user account's full name, empty when it has none. */
  async fullUserName(): Promise<string> {
    const reply = await this.helper.request<{ name?: unknown } | null>("fullUserName");
    if (typeof reply?.name !== "string") throw new HelperError("failed", "fullUserName", "no name in the reply");
    return reply.name;
  }

  /** The bundle identifier of the default email app. */
  async systemEmailApp(): Promise<string | null> {
    const { systemDefault } = await this.helper.request<{ systemDefault: { bundleIdentifier: string } | null }>("emailApps", { bundleIdentifiers: [] });
    return systemDefault?.bundleIdentifier ?? null;
  }

  /** The default email app and which of `bundleIdentifiers` are installed, for Settings. */
  emailApps(bundleIdentifiers: readonly string[]): Promise<{ systemDefault: EmailAppInfo | null; installed: EmailAppInfo[] }> {
    return this.helper.request("emailApps", { bundleIdentifiers });
  }

  /** The icon of the app at `path`, `pixels` square, as a PNG data URL; null when it can't be drawn.
   * The helper draws it: Electron's `app.getFileIcon` can hand back the system's blank placeholder. */
  async appIcon(path: string, pixels: number): Promise<string | null> {
    const { png } = await this.helper.request<{ png: string | null }>("appIcon", { path, pixels });
    return png === null ? null : `data:image/png;base64,${png}`;
  }

  /** The screen context of the app in front; null without one; that it is hidden when the app, or
   * the website it shows, is among `exclusions`, which the helper doesn't read. */
  readScreen(exclusions: ScreenExclusions): Promise<ScreenRead | null> {
    return this.helper.request<ScreenRead | null>("readScreen", { excludedAppIDs: exclusions.apps, excludedHosts: exclusions.sites }, config.screenReadTimeout);
  }

  /** The app at `path` (an `.app` the user picked); null when it is none. */
  async appInfo(path: string): Promise<EmailAppInfo | null> {
    return this.helper.request<EmailAppInfo | null>("appInfo", { path });
  }

  /** The caret's (or the focused field's) rect in `pid`, in top-left screen points; null when it
   * exposes none. */
  caretAnchor(pid: number): Promise<Rect | null> {
    return this.helper.request<Rect | null>("caretAnchor", { pid });
  }

  /** The text of the focused field of `pid`, for learning the user's corrections (ADR-DESK-038); null
   * for none, a password field, one longer than `config.correctionMaxFieldLength`, or an app or a
   * website among `exclusions`, which the helper doesn't read. */
  async focusedFieldValue(pid: number, exclusions: ScreenExclusions): Promise<string | null> {
    const reply = await this.helper.request<{ value?: unknown } | null>("focusedFieldValue", {
      pid,
      maxLength: config.correctionMaxFieldLength,
      excludedAppIDs: exclusions.apps,
      excludedHosts: exclusions.sites,
    });
    return typeof reply?.value === "string" ? reply.value : null;
  }

  /** Asks Gecko and Electron apps to build their accessibility tree as they come to the front. */
  async startActivator(): Promise<void> {
    await this.helper.request("startActivator");
  }

  readonly globeKey: GlobeKeySystem = {
    read: async () => (await this.helper.request<{ value: number | null }>("globeRead")).value,
    update: async (value) => {
      await this.helper.request("globeUpdate", { value });
    },
  };

  readonly thunderbird: ThunderbirdSystem = {
    applicationPath: async (app) => (await this.helper.request<{ path: string | null }>("appPath", { bundleIdentifier: app })).path,
    isRunning: (app) => this.flag("isRunning", app),
    launch: async (path) => {
      await this.helper.request("launch", { path });
    },
    hasWindow: (app) => this.flag("hasWindow", app),
    activate: async (app) => {
      await this.helper.request("activate", { bundleIdentifier: app });
    },
    isFrontmost: (app) => this.flag("isFrontmost", app),
    focusedElement: (app) => this.helper.request<FocusedElement | null>("focusedElement", { bundleIdentifier: app }),
    openChat: async () => {
      await this.helper.request("openTabMailChat");
    },
    paste: (text) => this.paste(text),
    pressReturn: async () => {
      await this.helper.request("pressReturn");
    },
  };

  /** Calendar and Reminders through EventKit in the helper (ADR-DESK-024); dates cross the wire as
   * milliseconds since 1970. Each request may wait on macOS asking the user for access. */
  readonly eventStore: EventStore = {
    events: async (start, end) => {
      const { events } = await this.eventRequest<{ events: EventJSON[] }>("calendarEvents", { start: start.getTime(), end: end.getTime() });
      return events.map(calendarEvent);
    },
    addEvent: async (event) =>
      calendarEvent(
        await this.eventRequest<EventJSON>("calendarAdd", {
          title: event.title,
          start: event.start.getTime(),
          end: event.end.getTime(),
          isAllDay: event.isAllDay,
          location: event.location,
          notes: event.notes,
        }),
      ),
    openReminders: async (dueBefore) => {
      const { reminders } = await this.eventRequest<{ reminders: ReminderJSON[] }>("reminders", { dueBefore: dueBefore?.getTime() ?? null });
      return reminders.map(reminderItem);
    },
    addReminder: async (reminder) =>
      reminderItem(await this.eventRequest<ReminderJSON>("reminderAdd", { title: reminder.title, due: reminder.due?.getTime() ?? null, dueHasTime: reminder.dueHasTime, notes: reminder.notes })),
  };

  /** A Calendar or Reminders request; one the helper refused for a reason the user can act on (no
   * access, no default calendar) fails with that reason's message, for the model to pass on. */
  private async eventRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.helper.request<T>(method, params, config.eventStoreRequestTimeout);
    } catch (error) {
      if (error instanceof HelperError && EventStoreError.isKind(error.helperMessage)) throw new EventStoreError(error.helperMessage);
      throw error;
    }
  }

  /** Contacts through the Contacts framework in the helper (ADR-DESK-025), which matches the search
   * itself, to stop at `limit` without sending the whole address book. Each request may wait on macOS
   * asking the user for access. */
  readonly contactStore: ContactStore = {
    search: async (query, limit) => (await this.contactRequest<{ contacts: ContactCard[] }>("contactsSearch", { query, limit })).contacts,
    add: async (contact) => await this.contactRequest<ContactCard>("contactsAdd", { ...contact }),
  };

  /** A Contacts request; one the helper refused for want of access fails saying where to allow it,
   * for the model to pass on. */
  private async contactRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.helper.request<T>(method, params, config.contactStoreRequestTimeout);
    } catch (error) {
      if (error instanceof HelperError && ContactStoreError.isKind(error.helperMessage)) throw new ContactStoreError(error.helperMessage);
      throw error;
    }
  }

  /** Spotlight and the Finder in the helper (ADR-DESK-026): the helper builds the Spotlight query and
   * decides what is only shown, not opened. */
  readonly fileStore: FileStore = {
    search: async (query, limit) => {
      const { items } = await this.fileRequest<{ items: FoundItemJSON[] }>("filesSearch", {
        words: query.words,
        kind: query.kind,
        changedAfter: query.changedAfter?.getTime() ?? null,
        changedBefore: query.changedBefore?.getTime() ?? null,
        limit,
      });
      return items.map(foundItem);
    },
    open: async (path, reveal) => (await this.fileRequest<{ opened: boolean }>("fileOpen", { path, reveal })).opened,
  };

  /** A Files request; one that failed goes back by name, for the model to pass on. */
  private async fileRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.helper.request<T>(method, params, config.fileStoreRequestTimeout);
    } catch (error) {
      if (error instanceof HelperError && FileStoreError.isKind(error.helperMessage)) throw new FileStoreError(error.helperMessage);
      throw error;
    }
  }

  private async flag(method: string, app: string): Promise<boolean> {
    return (await this.helper.request<{ value: boolean }>(method, { bundleIdentifier: app })).value;
  }
}

/** An event as the helper sends it: its times in milliseconds since 1970. */
interface EventJSON {
  title: string;
  start: number;
  end: number;
  isAllDay: boolean;
  calendar: string;
  location: string | null;
  notes: string | null;
}

function calendarEvent(json: EventJSON): CalendarEvent {
  return { ...json, start: new Date(json.start), end: new Date(json.end) };
}

/** A reminder as the helper sends it: its due time in milliseconds since 1970. */
interface ReminderJSON {
  title: string;
  list: string;
  due: number | null;
  dueHasTime: boolean;
  notes: string | null;
}

function reminderItem(json: ReminderJSON): ReminderItem {
  return { ...json, due: json.due === null ? null : new Date(json.due) };
}

/** A found item as the helper sends it: its change time in milliseconds since 1970. */
type FoundItemJSON = Omit<FoundItem, "changed"> & { changed: number | null };

function foundItem(json: FoundItemJSON): FoundItem {
  return { ...json, changed: json.changed === null ? null : new Date(json.changed) };
}

export interface EmailAppInfo {
  bundleIdentifier: string;
  name: string;
  path: string;
}
