// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { Arguments, type LoopTool, LoopToolArgumentError } from "./loopTool.js";

/** A person in the user's contacts, as the contacts tools read and add them. */
export interface ContactCard {
  firstName: string;
  lastName: string;
  organization: string;
  emails: string[];
  phones: string[];
}

/** "First Last", or the company for a contact with no name. */
export function displayName(contact: ContactCard): string {
  const name = [contact.firstName, contact.lastName].filter((part) => part !== "").join(" ");
  return name === "" ? contact.organization : name;
}

/** The user's contacts (Apple Contacts through `voice-macos` on a Mac, ADR-DESK-025). Access is asked
 * the first time a tool needs it; without it, a call throws saying where to allow it, and the model
 * tells the user. */
export interface ContactStore {
  /** Contacts whose name (either way round), company or an email address contains `query`, ignoring
   * case and accents, at most `limit`, in the user's sort order. */
  search(query: string, limit: number): Promise<ContactCard[]>;
  /** Adds `contact` to the default container and returns it as saved. */
  add(contact: ContactCard): Promise<ContactCard>;
}

/** Why Contacts could not be used: the model reads the message, and tells the user. */
export type ContactStoreFailureKind = "contactsNoAccess";

const contactStoreFailureMessages: Record<ContactStoreFailureKind, string> = {
  contactsNoAccess: "TabMail Voice can't use Contacts. Allow it in System Settings › Privacy & Security › Contacts.",
};

export class ContactStoreFailure extends Error {
  constructor(readonly kind: ContactStoreFailureKind) {
    super(contactStoreFailureMessages[kind]);
    this.name = "ContactStoreFailure";
  }

  static isKind(value: unknown): value is ContactStoreFailureKind {
    return typeof value === "string" && Object.hasOwn(contactStoreFailureMessages, value);
  }
}

/** The Contacts connector's tools. */
export function contactsTools(store: ContactStore): LoopTool[] {
  return [new ContactsSearchTool(store), new ContactsAddTool(store)];
}

/** Finds people in the user's contacts (`contacts_search`), for "what's Sam's email" or before
 * writing to someone the user names. */
export class ContactsSearchTool implements LoopTool {
  readonly name = "contacts_search";
  readonly connector = "contacts";
  readonly progressLabel = "Looking in your contacts";

  constructor(private readonly store: ContactStore) {}

  confirmation(): null {
    return null;
  }

  /** At most `contactsSearchMaxResults` matches: the model reads each, so a query matching a whole
   * company is cut short and says so. */
  async run(args: Record<string, unknown>): Promise<string> {
    const query = Arguments.text(args, "query");
    if (query === null) throw LoopToolArgumentError.missing("query");
    const limit = config.contactsSearchMaxResults;
    // One more than shown, to know whether there are more.
    const matches = await this.store.search(query, limit + 1);
    if (matches.length === 0) return `No contacts match "${query}".`;
    const lines = [`Contacts matching "${query}":`, ...matches.slice(0, limit).map((contact) => `- ${describeContact(contact)}`)];
    if (matches.length > limit) lines.push("(More contacts match; ask with more of the name.)");
    return lines.join("\n");
  }
}

/** A contact as the model reads it: its name, company, email addresses and phone numbers. */
export function describeContact(contact: ContactCard): string {
  const name = displayName(contact);
  let line = name === "" ? "No name" : name;
  if (contact.organization !== "" && contact.organization !== line) line += ` (${contact.organization})`;
  if (contact.emails.length > 0) line += `. Email: ${contact.emails.join(", ")}`;
  if (contact.phones.length > 0) line += `. Phone: ${contact.phones.join(", ")}`;
  return line;
}

/** Adds a person to the user's contacts (`contacts_add`), once they confirm what the chat window
 * shows: the question and the contact come from the same `draft`. */
export class ContactsAddTool implements LoopTool {
  readonly name = "contacts_add";
  readonly connector = "contacts";
  readonly progressLabel = "Adding the contact";

  constructor(private readonly store: ContactStore) {}

  /** Null only for arguments `run` rejects before adding anything. */
  confirmation(args: Record<string, unknown>): string | null {
    let contact: ContactCard;
    try {
      contact = ContactsAddTool.draft(args);
    } catch {
      return null;
    }
    const name = displayName(contact);
    const lines = ["Add this contact?"];
    if (name !== "") lines.push(name);
    if (contact.organization !== "" && contact.organization !== name) lines.push(contact.organization);
    // Every field the contact is added with is shown: text the user never saw could carry anything.
    return [...lines, ...contact.emails, ...contact.phones].join("\n");
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const saved = await this.store.add(ContactsAddTool.draft(args));
    return `Added ${describeContact(saved)} to the contacts.`;
  }

  /** The contact the arguments describe: at least a name, a company or an email address, and one
   * email address and one phone number, as the backend's schema gives them. */
  static draft(args: Record<string, unknown>): ContactCard {
    const email = Arguments.text(args, "email");
    const phone = Arguments.text(args, "phone");
    const contact: ContactCard = {
      firstName: Arguments.text(args, "first_name") ?? "",
      lastName: Arguments.text(args, "last_name") ?? "",
      organization: Arguments.text(args, "organization") ?? "",
      emails: email === null ? [] : [email],
      phones: phone === null ? [] : [phone],
    };
    if (displayName(contact) === "" && contact.emails.length === 0) throw new LoopToolArgumentError("Give at least a name, a company or an email address.");
    return contact;
  }
}
