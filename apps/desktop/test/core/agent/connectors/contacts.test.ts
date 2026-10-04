// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "vitest";
import {
  type ContactCard,
  ContactsAddTool,
  ContactsSearchTool,
  type ContactStore,
  ContactStoreError,
  contactsConnector,
  describeContact,
} from "../../../../src/core/agent/connectors/contacts.js";
import { ToolArgumentError } from "../../../../src/core/agent/connectors/contract.js";
import * as config from "../../../../src/core/config.js";

/** Contacts as the Answer prompt's tools, against a fake store: what the model searches for, what the
 * user is asked to confirm, and what the model reads back (from the Swift `ContactsToolsTests`; the
 * matching itself is the helper's, in `ContactStoreTests`). */

/** Contacts in memory, recording what the tools asked of them. A search matches a name, company or
 * email address containing the query, ignoring case. */
class FakeContactStore implements ContactStore {
  contacts: ContactCard[] = [];
  failure: Error | null = null;
  readonly searches: { query: string; limit: number }[] = [];
  readonly added: ContactCard[] = [];

  async search(query: string, limit: number): Promise<ContactCard[]> {
    if (this.failure) throw this.failure;
    this.searches.push({ query, limit });
    const needle = query.toLowerCase();
    const matches = (contact: ContactCard) => [contact.firstName, contact.lastName, contact.organization, ...contact.emails].some((field) => field.toLowerCase().includes(needle));
    return this.contacts.filter(matches).slice(0, limit);
  }

  async add(contact: ContactCard): Promise<ContactCard> {
    if (this.failure) throw this.failure;
    this.added.push(contact);
    return contact;
  }
}

function card(fields: Partial<ContactCard>): ContactCard {
  return { firstName: "", lastName: "", organization: "", emails: [], phones: [], ...fields };
}

const sam = card({ firstName: "Sam", lastName: "Example", organization: "Company", emails: ["sam@example.com", "sam.example@company.com"], phones: ["+1 555 0100"] });

let store: FakeContactStore;
beforeEach(() => {
  store = new FakeContactStore();
});

describe("contacts_search", () => {
  /** Each match with its company, email addresses and phone numbers, searched for as asked. */
  test("the matches are read with their details", async () => {
    store.contacts = [sam, card({ organization: "Domain", emails: ["hello@example.com"] }), card({ firstName: "Alex" })];
    const tool = new ContactsSearchTool(store);

    const result = await tool.run({ query: " example " });

    expect(store.searches.map((search) => search.query)).toEqual(["example"]);
    expect(result).toBe(
      ['Contacts matching "example":', "- Sam Example (Company). Email: sam@example.com, sam.example@company.com. Phone: +1 555 0100", "- Domain. Email: hello@example.com"].join("\n"),
    );
  });

  test("no match says so", async () => {
    const tool = new ContactsSearchTool(store);

    expect(await tool.run({ query: "Alex" })).toBe('No contacts match "Alex".');
  });

  /** A search matching more than the model is shown stops at the limit and says there are more. */
  test("a search matching many is cut short and says so", async () => {
    const limit = config.contactsSearchMaxResults;
    store.contacts = Array.from({ length: limit + 1 }, (_, index) => card({ firstName: `Person${index}`, organization: "Company" }));
    const tool = new ContactsSearchTool(store);

    const lines = (await tool.run({ query: "Company" })).split("\n");

    expect(store.searches.map((search) => search.limit)).toEqual([limit + 1]);
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(limit);
    expect(lines.at(-1)).toBe("(More contacts match; ask with more of the name.)");
    store.contacts.pop();
    const all = (await tool.run({ query: "Company" })).split("\n");
    expect(all.filter((line) => line.startsWith("- "))).toHaveLength(limit);
    expect(all.join("\n")).not.toContain("More contacts match");
  });

  test.each<Record<string, unknown>>([{}, { query: "  " }, { query: 7 }])("%j is not searched", async (args) => {
    const tool = new ContactsSearchTool(store);

    await expect(tool.run(args)).rejects.toEqual(ToolArgumentError.missing("query"));
    expect(store.searches).toEqual([]);
  });

  /** Without access to Contacts, the tool fails saying where to allow it, which the model tells the
   * user. */
  test("no access says where to allow it", async () => {
    store.failure = new ContactStoreError("contactsNoAccess");
    const tool = new ContactsSearchTool(store);

    await expect(tool.run({ query: "Sam" })).rejects.toBe(store.failure);
    expect(store.failure.message).toContain("System Settings › Privacy & Security › Contacts");
    expect(ContactStoreError.isKind("contactsNoAccess")).toBe(true);
    expect(ContactStoreError.isKind("toString")).toBe(false);
  });

  /** A contact with no name is its company, and one with neither says so; a company that is its name
   * is shown once. */
  test("a contact is named by its name, else its company", () => {
    expect(describeContact(card({ emails: ["hello@domain.com"] }))).toBe("No name. Email: hello@domain.com");
    expect(describeContact(card({ organization: "Domain", phones: ["+1 555 0100"] }))).toBe("Domain. Phone: +1 555 0100");
    expect(describeContact(card({ lastName: "Example" }))).toBe("Example");
  });
});

describe("contacts_add", () => {
  /** The user is asked about the contact as it will be added, every field it is added with shown,
   * and it is added as asked. */
  test("a contact is added as the user confirmed it", async () => {
    const tool = new ContactsAddTool(store);
    const args = { first_name: " Sam ", last_name: "Example", organization: "Company", email: "sam@example.com", phone: "+1 555 0100" };

    const question = tool.confirmation(args);
    const result = await tool.run(args);

    expect(question).toBe("Add this contact?\nSam Example\nCompany\nsam@example.com\n+1 555 0100");
    expect(store.added).toEqual([card({ firstName: "Sam", lastName: "Example", organization: "Company", emails: ["sam@example.com"], phones: ["+1 555 0100"] })]);
    expect(result).toBe("Added Sam Example (Company). Email: sam@example.com. Phone: +1 555 0100 to the contacts.");
  });

  /** A company alone or an email address alone is enough, and is shown once. */
  test("a company or an email address alone is enough", async () => {
    const tool = new ContactsAddTool(store);

    expect(tool.confirmation({ organization: "Company" })).toBe("Add this contact?\nCompany");
    expect(tool.confirmation({ email: "hello@domain.com" })).toBe("Add this contact?\nhello@domain.com");
    expect(tool.confirmation({ last_name: "Example", organization: "Company" })).toBe("Add this contact?\nExample\nCompany");
    expect(await tool.run({ email: "hello@domain.com" })).toBe("Added No name. Email: hello@domain.com to the contacts.");
  });

  /** A contact with no name, company or email address is neither asked about nor added: the model is
   * told why. */
  test.each<Record<string, unknown>>([{}, { phone: "+1 555 0100" }, { first_name: "  " }, { first_name: 7, email: 7 }])("%j is neither asked about nor added", async (args) => {
    const tool = new ContactsAddTool(store);

    expect(tool.confirmation(args)).toBeNull();
    await expect(tool.run(args)).rejects.toEqual(new ToolArgumentError("Give at least a name, a company or an email address."));
    expect(store.added).toEqual([]);
  });
});

describe("connectors", () => {
  /** The Contacts switch covers both tools, and only adding asks first. */
  test("the Contacts switch covers its tools", () => {
    const tools = contactsConnector.tools({ contactStore: store });
    expect(tools.map((tool) => [tool.connector, tool.name])).toEqual([
      ["contacts", "contacts_search"],
      ["contacts", "contacts_add"],
    ]);
    const valid = { query: "Sam", first_name: "Sam" };
    expect(tools.map((tool) => tool.confirmation(valid) !== null)).toEqual([false, true]);
  });
});

test("contact writes disclose the provider destination, not a model-supplied destination", async () => {
  const provider = Object.assign(store, { writeDestination: "TabMail Voice contacts (local to this PC)" });
  const tool = new ContactsAddTool(provider);
  const args = { first_name: "Synthetic", destination: "Cloud account" };
  provider.writeDestination = "Changed after tool construction";
  expect(tool.confirmation(args)).toContain("Destination: TabMail Voice contacts (local to this PC)");
  expect(tool.confirmation(args)).not.toContain("Cloud account");
  expect(await tool.run(args)).toContain("to TabMail Voice contacts (local to this PC).");
  expect(store.added).toEqual([card({ firstName: "Synthetic" })]);
});
