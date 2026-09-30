// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "vitest";
import { connectorIds } from "../../../../src/core/agent/connectors/registry.js";
import { type EmailOpener, EmailComposeTool, emailTools, isAddress, mailtoURL, NoEmailAppError } from "../../../../src/core/agent/connectors/email.js";
import { ToolArgumentError } from "../../../../src/core/agent/connectors/tool.js";

/** Email as the Answer prompt's tool: a new email filled in, as a `mailto:` URL, opened in the user's
 * email app and never sent (from the Swift `EmailToolsTests`). */

/** Records the drafts opened, never opening an app. */
class FakeEmailOpener implements EmailOpener {
  failure: Error | null = null;
  readonly opened: string[] = [];

  async open(url: string): Promise<string> {
    if (this.failure) throw this.failure;
    this.opened.push(url);
    return "Mail";
  }
}

/** Reads a `mailto:` URL back, as an email app does: the recipients and each field, decoded. */
function parse(url: string): { to: string[]; fields: Record<string, string> } {
  expect(url.startsWith("mailto:")).toBe(true);
  const rest = url.slice("mailto:".length);
  const queryStart = rest.indexOf("?");
  const path = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const fields: Record<string, string> = {};
  if (queryStart !== -1) {
    for (const pair of rest.slice(queryStart + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals !== -1) fields[pair.slice(0, equals)] = decodeURIComponent(pair.slice(equals + 1));
    }
  }
  return { to: path.split(",").map(decodeURIComponent), fields };
}

const draft = (fields: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }) => ({ cc: [], bcc: [], ...fields });

let opener: FakeEmailOpener;
beforeEach(() => {
  opener = new FakeEmailOpener();
});

describe("the mailto URL", () => {
  test("the draft is a mailto URL", () => {
    expect(mailtoURL(draft({ to: ["sam@example.com", "alex@example.com"], cc: ["team@example.com"], subject: "Friday", body: "Hi Sam,\nSee you then." }))).toBe(
      "mailto:sam@example.com,alex@example.com?cc=team@example.com&subject=Friday&body=Hi%20Sam%2C%0D%0ASee%20you%20then.",
    );
    expect(mailtoURL(draft({ to: ["sam@example.com"], subject: "", body: "" }))).toBe("mailto:sam@example.com");
  });

  /** Whatever the model writes reads back unchanged: characters that mean something in a URL stay in
   * their field, and every line break is CRLF. */
  test("every field reads back as written", () => {
    const subject = "Q&A: 50% off? #launch = a+b (it's *new*!)";
    const body = "Line one & two\r\nLine=three?\rLine #four\n\n– café 🎉 +1 %20";

    const { to, fields } = parse(mailtoURL(draft({ to: ["sam+tag@example.com"], cc: ["a@example.com", "b@example.com"], bcc: ["c@example.com"], subject, body })));

    expect(to).toEqual(["sam+tag@example.com"]);
    expect(fields).toEqual({ cc: "a@example.com,b@example.com", bcc: "c@example.com", subject, body: "Line one & two\r\nLine=three?\r\nLine #four\r\n\r\n– café 🎉 +1 %20" });
  });

  /** Only the unreserved characters are left as they are, so nothing in a value can end its field. */
  test("only the unreserved characters are left unescaped", () => {
    const url = mailtoURL(draft({ to: ["sam@example.com"], subject: "!'()*,;:/@$", body: "x" }));

    expect(url).toBe("mailto:sam@example.com?subject=%21%27%28%29%2A%2C%3B%3A%2F%40%24&body=x");
  });

  /** A lone surrogate, which the model's JSON can carry, becomes U+FFFD instead of failing the call. */
  test("a lone surrogate is replaced, not thrown on", () => {
    expect(parse(mailtoURL(draft({ to: ["sam@example.com"], subject: "a\uD800b", body: "x" }))).fields.subject).toBe("a�b");
  });

  test.each(["sam@example.com", "first.last+tag@mail.example.co.uk"])("%j is an address", (text) => {
    expect(isAddress(text)).toBe(true);
  });

  test.each([
    "Sam",
    "sam@example",
    "sam@@example.com",
    "Sam <sam@example.com>",
    "a@example.com,b@example.com",
    "sam,alex@example.com",
    "sam@example.com;alex.com",
    "sam @example.com",
    "sam@example.com?cc=x@example.com",
    "sam@example.com\nbcc@example.com",
    "sam@example.com.",
    "",
  ])("%j is not an address", (text) => {
    expect(isAddress(text)).toBe(false);
  });
});

describe("email_compose", () => {
  /** The email opens in the email app, filled in as the model wrote it (blank recipients left out),
   * and nothing is asked: nothing is sent. */
  test("the email opens filled in", async () => {
    const tool = new EmailComposeTool(opener);
    const args = { to: ["sam@example.com", " "], cc: [" team@example.com "], subject: "Re: Friday", body: "Friday works.\n\n  Thanks" };

    const result = await tool.run(args);

    expect(tool.confirmation()).toBeNull();
    expect(opener.opened).toEqual([mailtoURL(draft({ to: ["sam@example.com"], cc: ["team@example.com"], subject: "Re: Friday", body: "Friday works.\n\n  Thanks" }))]);
    expect(result).toBe("Opened a new email to sam@example.com in Mail, for the user to review and send. Nothing was sent.");
  });

  /** A Bcc and the body's own indents and line breaks, leading and trailing, reach the draft. */
  test("a Bcc and the body as written are kept", async () => {
    const tool = new EmailComposeTool(opener);

    await tool.run({ to: ["sam@example.com"], bcc: ["c@example.com"], subject: "Notes", body: "  Indented\nLast line\n" });

    expect(opener.opened).toEqual([mailtoURL(draft({ to: ["sam@example.com"], bcc: ["c@example.com"], subject: "Notes", body: "  Indented\nLast line\n" }))]);
  });

  /** Arguments it can't use open nothing: the model is told why. */
  test.each<Record<string, unknown>>([
    { subject: "Friday", body: "Hi" },
    { to: [], subject: "Friday", body: "Hi" },
    { to: "sam@example.com", subject: "Friday", body: "Hi" },
    { to: [7, null], subject: "Friday", body: "Hi" },
    { to: ["sam@example.com"], body: "Hi" },
    { to: ["sam@example.com"], subject: " ", body: "Hi" },
    { to: ["sam@example.com"], subject: "Friday" },
    { to: ["sam@example.com"], subject: "Friday", body: " \n" },
    { to: ["sam@example.com"], subject: "Friday", body: 7 },
    { to: ["Sam"], subject: "Friday", body: "Hi" },
    { to: ["sam@example.com"], cc: ["Alex"], subject: "Friday", body: "Hi" },
    { to: ["sam@example.com"], bcc: ["the team"], subject: "Friday", body: "Hi" },
  ])("%j opens nothing", async (args) => {
    const tool = new EmailComposeTool(opener);

    await expect(tool.run(args)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(opener.opened).toEqual([]);
  });

  /** A name goes back to the model to look up. */
  test("a name is sent back to be looked up", async () => {
    const tool = new EmailComposeTool(opener);

    await expect(tool.run({ to: ["Sam"], subject: "Friday", body: "Hi" })).rejects.toThrow('to takes email addresses, not "Sam": find the address with contacts_search, or ask the user.');
  });

  /** With no email app to open it, the tool says so, which the model tells the user. */
  test("no email app says so", async () => {
    opener.failure = new NoEmailAppError();
    const tool = new EmailComposeTool(opener);

    await expect(tool.run({ to: ["sam@example.com"], subject: "Friday", body: "Hi" })).rejects.toThrow("No email app is set up on this computer to open a new email.");
  });

  /** The Email switch covers its one tool, which asks nothing. */
  test("the Email switch covers its tool", () => {
    const tools = emailTools(opener);

    expect(tools.map((tool) => [tool.connector, tool.name])).toEqual([["email", "email_compose"]]);
    expect(connectorIds).toContain("email");
  });
});
