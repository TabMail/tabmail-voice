// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { CancellationError } from "../../util/timeout.js";
import { Arguments, type ConnectorServices, type ConnectorTool, defineConnector, ToolArgumentError } from "./contract.js";

/** A web page's response as `web_read` reads it: at most `webReadMaxBytes` of its body. */
export interface WebResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  body: Uint8Array;
}

/** Gets `url` with `headers`, giving up after `timeout` milliseconds; `signal` ends it with a
 * `CancellationError`. Injectable, so tests never touch the network. */
export type WebFetch = (url: string, headers: Record<string, string>, timeout: number, signal: AbortSignal) => Promise<WebResponse>;

/** The network, through fetch (redirects followed). The body is read up to `webReadMaxBytes`: a page is
 * cut at `webReadMaxCharacters` anyway, and an endless one must not fill the memory. */
export const liveWebFetch: WebFetch = async (url, headers, timeout, signal) => {
  const timer = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.any([signal, timer]) });
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (length < config.webReadMaxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        length += value.length;
      }
      await reader.cancel();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return { status: response.status, statusText: response.statusText, contentType: response.headers.get("content-type"), body: body.subarray(0, config.webReadMaxBytes) };
  } catch (error) {
    if (signal.aborted) throw new CancellationError();
    if (timer.aborted) throw new Error(`timed out after ${timeout / 1_000} seconds`, { cause: error });
    throw error;
  }
};

/** The `url` argument, only a complete http or https URL (which always has a host): any other scheme
 * could open an app (a `shortcuts:` link runs a shortcut), which a web tool must never do. */
export function webURL(args: Record<string, unknown>): URL {
  const text = Arguments.text(args, "url");
  if (text === null) throw ToolArgumentError.missing("url");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw notAWebURL(text);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw notAWebURL(text);
  return url;
}

function notAWebURL(text: string): ToolArgumentError {
  return new ToolArgumentError(`url must be a complete http:// or https:// URL, not "${text}".`);
}

/** Why a page wasn't read, which the model reads. */
export class WebReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebReadError";
  }
}

/**
 * A web page as `web_read` gives it to the model, read as the Thunderbird add-on's `web_read.js` reads
 * it (ADR-DESK-030): the site's robots.txt first, then the page, both as `webUserAgent`, its text
 * extracted when it is HTML, cut at `webReadMaxCharacters`, in the same result format. The backend has
 * already refused a URL the model composed, a private address and every scheme but http and https.
 */
export class WebPageReader {
  constructor(private readonly fetch: WebFetch) {}

  async read(url: URL, signal: AbortSignal): Promise<string> {
    if (!(await this.robotsAllow(url, signal))) throw new WebReadError("Access to this URL is disallowed by the site's robots.txt");
    let response: WebResponse;
    try {
      response = await this.fetch(url.href, { "User-Agent": config.webUserAgent }, config.webReadTimeout, signal);
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      throw new WebReadError(`Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== 200) throw new WebReadError(`HTTP error: ${response.status} ${response.statusText}`.trimEnd());
    const contentType = response.contentType ?? "text/plain";
    // The model's context, not storage: a page longer than this is cut, as on Thunderbird and iOS.
    const content = decoded(response.body, contentType).slice(0, config.webReadMaxCharacters);
    const text = contentType.includes("text/html") || contentType.includes("application/xhtml") ? WebPageReader.text(content) : content;
    return [`URL: ${url.href}`, `Content-Type: ${contentType}`, `Content-Length: ${text.length} characters`, "", "Content:", text].join("\n");
  }

  /** Whether the site's robots.txt lets us read `url`: allowed when it has none or it can't be read. */
  private async robotsAllow(url: URL, signal: AbortSignal): Promise<boolean> {
    let response: WebResponse;
    try {
      response = await this.fetch(`${url.protocol}//${url.host}/robots.txt`, { "User-Agent": config.webUserAgent }, config.webReadRobotsTimeout, signal);
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      return true;
    }
    if (response.status !== 200) return true;
    return WebPageReader.isPathAllowed(decoded(response.body, "text/plain"), url.pathname, config.webUserAgent);
  }

  /** Whether robots.txt lets `userAgent` read `path`: the `*` or `userAgent` group's rules, an Allow
   * prefix winning over a Disallow one (`isPathAllowedByRobots` in the add-on). */
  static isPathAllowed(robotsTxt: string, path: string, userAgent: string): boolean {
    let currentAgent: string | null = null;
    let disallowRules: string[] = [];
    let allowRules: string[] = [];
    for (const line of robotsTxt.split("\n")) {
      const trimmed = line.trim();
      // A comment line starts with `#`, so it is never a directive.
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("user-agent:")) {
        const agent = trimmed.slice("user-agent:".length).trim();
        currentAgent = agent;
        if (agent !== "*" && agent !== userAgent) {
          disallowRules = [];
          allowRules = [];
        }
      } else if (currentAgent === "*" || currentAgent === userAgent) {
        if (lower.startsWith("disallow:")) {
          const rule = trimmed.slice("disallow:".length).trim();
          if (rule !== "") disallowRules.push(rule);
        } else if (lower.startsWith("allow:")) {
          const rule = trimmed.slice("allow:".length).trim();
          if (rule !== "") allowRules.push(rule);
        }
      }
    }
    if (allowRules.some((rule) => path.startsWith(rule))) return true;
    return !disallowRules.some((rule) => path.startsWith(rule));
  }

  /** A page's readable text: scripts, styles and page chrome dropped, block ends as line breaks, tags
   * removed, entities decoded, blank runs collapsed (the add-on's `extractTextFromHTML`, without a DOM). */
  static text(html: string): string {
    let text = html;
    for (const tag of ["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]) {
      text = withoutElements(text, tag);
    }
    text = text.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n");
    // `[^<>]`, not `[^>]`: from every `<` of a page with no `>`, `[^>]+` would scan to its end.
    text = text.replace(/<[^<>]+>/g, " ");
    text = text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&apos;", "'")
      .replaceAll("&nbsp;", " ")
      .replace(/&#(\d+);/g, (entity, code: string) => character(Number.parseInt(code, 10)) ?? entity)
      .replace(/&#x([0-9a-f]+);/gi, (entity, code: string) => character(Number.parseInt(code, 16)) ?? entity)
      // Last, so `&amp;lt;` reads as the text `&lt;`, not as `<`.
      .replaceAll("&amp;", "&");
    text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
    text = text.replace(/[ \t]+/g, " ");
    return text.trim();
  }
}

/** `html` without each `tag` element and its contents, in one pass. A lazy `<tag>[\s\S]*?</tag>`
 * regex scans to the end from every opening tag with no closing one after it, which a hostile page of
 * half a million `<script` repeats until the main process stalls for minutes. */
function withoutElements(html: string, tag: string): string {
  // The name ends at a space, `/` or `>`: `\b` would take a custom element such as `<nav-menu>` for a
  // `<nav>` and drop the page up to the next `</nav>`. A closing tag may have spaces before its `>`.
  const open = new RegExp(`<${tag}(?=[\\s/>])[^<>]*>`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  let kept = "";
  let from = 0;
  for (let start = open.exec(html); start; start = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    // No closing tag after this opening one, so none after any later one either.
    if (!close.exec(html)) break;
    kept += html.slice(from, start.index);
    from = close.lastIndex;
    open.lastIndex = from;
  }
  return kept + html.slice(from);
}

/** The character a numeric entity names, or null for no character. */
function character(code: number): string | null {
  return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : null;
}

/** `body` as text in the charset `contentType` names, UTF-8 when it names none or one this runtime
 * doesn't know. */
function decoded(body: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    // A label TextDecoder doesn't know: its only error (a RangeError); decoding without `fatal` never throws.
    return new TextDecoder("utf-8").decode(body);
  }
}

/** Its web search runs on the backend (`serverTools`). */
export const webConnector = defineConnector({
  id: "web",
  order: 80,
  platforms: ["darwin", "win32", "linux"],
  displayName: "Web",
  settingsDescription: "Searches the web, reads pages, and opens the ones you ask for in your browser.",
  serverTools: [config.webSearchTool],
  tools: ({ webFetch, webOpener }: Pick<ConnectorServices, "webFetch" | "webOpener">): ConnectorTool[] => [new WebReadTool(new WebPageReader(webFetch)), new WebOpenTool(webOpener)],
});

/** Reads a web page's text (`web_read`), as the Thunderbird add-on and the iOS app do; a URL from what
 * the user said or a search result, which the backend checked before handing the call over. Reading
 * is neither sending nor creating, so nothing is asked first. */
export class WebReadTool implements ConnectorTool {
  readonly name = "web_read";
  readonly connector = "web";
  readonly progressLabel = "Reading the page";

  constructor(private readonly reader: WebPageReader) {}

  confirmation(): null {
    return null;
  }

  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    return this.reader.read(webURL(args), signal);
  }
}

/** Opens a URL in the user's browser. */
export interface WebOpener {
  open(url: string): Promise<void>;
}

/** Opens a web page in the user's browser (`web_open`); a URL from what the user said or a search
 * result, which the backend checked before handing the call over. Opening is neither sending nor
 * creating, so nothing is asked first. */
export class WebOpenTool implements ConnectorTool {
  readonly name = "web_open";
  readonly connector = "web";
  readonly progressLabel = "Opening the page";

  constructor(private readonly opener: WebOpener) {}

  confirmation(): null {
    return null;
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const url = webURL(args);
    await this.opener.open(url.href);
    return `Opened ${url.href} in the browser.`;
  }
}
