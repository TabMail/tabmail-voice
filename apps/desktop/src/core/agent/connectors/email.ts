// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Arguments, type ConnectorServices, type ConnectorTool, defineConnector, ToolArgumentError } from "./contract.js";

/** A new email for the user to review and send in their email app (`email_compose`). */
export interface EmailDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** Opens a draft in the user's email app (ADR-DESK-027). */
export interface EmailOpener {
  /** Opens `url` (a `mailto:` URL) and returns the name of the app that opened it; throws
   * `NoEmailAppError` when no app opens `mailto:` links. */
  open(url: string): Promise<string>;
}

/** No app on this computer opens `mailto:` links: the model reads the message, and tells the user. */
export class NoEmailAppError extends Error {
  constructor() {
    super("No email app is set up on this computer to open a new email.");
    this.name = "NoEmailAppError";
  }
}

/** The draft as a `mailto:` URL (RFC 6068), which every email app opens as a filled-in new message:
 * the recipients in the path, the rest as query fields, every value percent-encoded so an `&`, `=`,
 * `?` or `#` in it stays in it, and line breaks as CRLF. */
export function mailtoURL(draft: EmailDraft): string {
  const fields = [
    ["cc", draft.cc.map(encodedAddress).join(",")],
    ["bcc", draft.bcc.map(encodedAddress).join(",")],
    ["subject", encoded(draft.subject)],
    ["body", encoded(crlf(draft.body))],
  ].filter(([, value]) => value !== "");
  const query = fields.length === 0 ? "" : `?${fields.map(([name, value]) => `${name}=${value}`).join("&")}`;
  return `mailto:${draft.to.map(encodedAddress).join(",")}${query}`;
}

/** Whether `text` is one email address (`name@example.com`): not a name, not a list. */
export function isAddress(text: string): boolean {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]+$/u.test(text);
}

const unreserved = /^[A-Za-z0-9\-._~]$/;

/** `text`'s UTF-8 bytes, each outside the unreserved set (and `keep`) as a `%XX` escape. A lone
 * surrogate the model's JSON may carry becomes U+FFFD rather than throwing, as `encodeURIComponent`
 * would. */
function encoded(text: string, keep = ""): string {
  let result = "";
  for (const byte of new TextEncoder().encode(text)) {
    const character = String.fromCharCode(byte);
    result += unreserved.test(character) || keep.includes(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

function encodedAddress(address: string): string {
  return encoded(address, "@");
}

function crlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

export const emailConnector = defineConnector({
  id: "email",
  order: 50,
  displayName: "Email",
  settingsDescription: "Opens a new email in your email app, written for you to review and send.",
  tools: ({ emailOpener }: Pick<ConnectorServices, "emailOpener">): ConnectorTool[] => [new EmailComposeTool(emailOpener)],
});

/** Opens a new email, filled in, in the user's email app (`email_compose`), for them to review and
 * send. Nothing is sent, so nothing is asked first (owner, 2026-09-26: mail without TabMail is
 * prefill only). */
export class EmailComposeTool implements ConnectorTool {
  readonly name = "email_compose";
  readonly connector = "email";
  readonly progressLabel = "Writing the email";

  constructor(private readonly opener: EmailOpener) {}

  confirmation(): null {
    return null;
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const draft = EmailComposeTool.draft(args);
    const app = await this.opener.open(mailtoURL(draft));
    return `Opened a new email to ${draft.to.join(", ")} in ${app}, for the user to review and send. Nothing was sent.`;
  }

  /** The draft the arguments describe: at least one recipient, every one an email address, a subject
   * and a body (kept as written, its line breaks and indents included). */
  static draft(args: Record<string, unknown>): EmailDraft {
    const to = addresses(args, "to");
    if (to.length === 0) throw ToolArgumentError.missing("to");
    const subject = Arguments.text(args, "subject");
    if (subject === null) throw ToolArgumentError.missing("subject");
    const body = args.body;
    if (typeof body !== "string" || Arguments.text(args, "body") === null) throw ToolArgumentError.missing("body");
    return { to, cc: addresses(args, "cc"), bcc: addresses(args, "bcc"), subject, body };
  }
}

/** The addresses in the list argument `name`, blanks left out; a name or anything else that is not
 * one address goes back to the model to look up. */
function addresses(args: Record<string, unknown>, name: string): string[] {
  const list = args[name];
  const values = (Array.isArray(list) ? list : []).flatMap((value) => (typeof value === "string" ? [value.trim()] : [])).filter((value) => value !== "");
  const other = values.find((value) => !isAddress(value));
  if (other !== undefined) throw new ToolArgumentError(`${name} takes email addresses, not "${other}": find the address with contacts_search, or ask the user.`);
  return values;
}
