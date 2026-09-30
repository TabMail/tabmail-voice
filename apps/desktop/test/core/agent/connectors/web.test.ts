// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolArgumentError } from "../../../../src/core/agent/connectors/tool.js";
import { liveWebFetch, type WebFetch, WebOpenTool, WebPageReader, WebReadError, WebReadTool, type WebResponse, webTools, webURL } from "../../../../src/core/agent/connectors/web.js";
import * as config from "../../../../src/core/config.js";
import { CancellationError } from "../../../../src/core/util/timeout.js";

// A small body cap, so a page can run past it: every other page stays far below.
vi.mock("../../../../src/core/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../../../src/core/config.js")>()), webReadMaxBytes: 4_096 }));

/** The web as `web_read` reads it (ADR-DESK-030, from the add-on's `web_read.js` and the Swift
 * `WebToolsTests`): through a fake fetch, and `liveWebFetch` against a server on this computer. No
 * test reaches the network. */

const signal = new AbortController().signal;
const encoder = new TextEncoder();

/** Answers each URL from `pages` (404 for any other), recording every request. */
class FakeWeb {
  readonly pages = new Map<string, Partial<WebResponse> | Error>();
  readonly requests: { url: string; headers: Record<string, string>; timeout: number; signal: AbortSignal }[] = [];

  readonly fetch: WebFetch = async (url, headers, timeout, signal) => {
    this.requests.push({ url, headers, timeout, signal });
    const page = this.pages.get(url);
    if (page instanceof Error) throw page;
    return { status: 404, statusText: "Not Found", contentType: null, body: new Uint8Array(), ...page };
  };

  page(url: string, text: string, contentType: string | null = "text/plain"): void {
    this.pages.set(url, { status: 200, statusText: "OK", contentType, body: encoder.encode(text) });
  }
}

let web: FakeWeb;
let reader: WebPageReader;

beforeEach(() => {
  web = new FakeWeb();
  reader = new WebPageReader(web.fetch);
});

describe("the connector", () => {
  test("Web has web_read and web_open, and neither asks", () => {
    const tools = webTools(web.fetch, { open: async () => {} });

    expect(tools.map((tool) => [tool.name, tool.connector])).toEqual([
      ["web_read", "web"],
      ["web_open", "web"],
    ]);
    expect(tools.map((tool) => tool.confirmation({ url: "https://example.com/" }))).toEqual([null, null]);
  });
});

describe("a web URL", () => {
  test.each(["https://example.com/page?q=1#top", "http://example.com:8080/", " HTTPS://Example.com/a "])("%j is one", (text) => {
    expect(webURL({ url: text }).href).toBe(new URL(text.trim()).href);
  });

  /** Only a complete http or https URL: another scheme could open an app (a `shortcuts:` link runs a
   * shortcut), a `file:` one a local file. */
  test.each(["shortcuts://run-shortcut?name=Example", "file:///etc/hosts", "javascript:alert(1)", "mailto:sam@example.com", "ftp://example.com/", "example.com/page", "/page", "https://"])("%j is not one", (text) => {
    expect(() => webURL({ url: text })).toThrow(new ToolArgumentError(`url must be a complete http:// or https:// URL, not "${text}".`));
  });

  test.each([{}, { url: " " }, { url: 7 }])("%j has none", (args) => {
    expect(() => webURL(args)).toThrow(ToolArgumentError.missing("url"));
  });
});

describe("web_read", () => {
  test("a page is read after its site's robots.txt, both as TabMail", async () => {
    web.page("https://example.com/robots.txt", "User-agent: *\nDisallow: /private/");
    web.page("https://example.com/docs/page", "Plain words.", "text/plain; charset=utf-8");

    const result = await new WebReadTool(reader).run({ url: "https://example.com/docs/page" }, signal);

    expect(result).toBe("URL: https://example.com/docs/page\nContent-Type: text/plain; charset=utf-8\nContent-Length: 12 characters\n\nContent:\nPlain words.");
    expect(web.requests.map((request) => [request.url, request.headers["User-Agent"], request.timeout, request.signal])).toEqual([
      ["https://example.com/robots.txt", config.webUserAgent, config.webReadRobotsTimeout, signal],
      ["https://example.com/docs/page", config.webUserAgent, config.webReadTimeout, signal],
    ]);
  });

  /** robots.txt is asked of the page's own site, port included. */
  test("robots.txt is the site's, port included", async () => {
    await reader.read(new URL("http://example.com:8080/a/b?c=d"), signal).catch(() => {});

    expect(web.requests[0]?.url).toBe("http://example.com:8080/robots.txt");
  });

  test("a page robots.txt disallows is not read", async () => {
    web.page("https://example.com/robots.txt", "User-agent: *\nDisallow: /private/");
    web.page("https://example.com/private/page", "Secret.");

    await expect(reader.read(new URL("https://example.com/private/page"), signal)).rejects.toEqual(new WebReadError("Access to this URL is disallowed by the site's robots.txt"));
    expect(web.requests.map((request) => request.url)).toEqual(["https://example.com/robots.txt"]);
  });

  /** Only the path is matched, as in the add-on: a rule naming a query refuses no page. */
  test("robots.txt rules are matched against the path, not the query", async () => {
    web.page("https://example.com/robots.txt", "User-agent: *\nDisallow: /page?x");
    web.page("https://example.com/page?x=1", "Words.");

    expect(await reader.read(new URL("https://example.com/page?x=1"), signal)).toContain("Content:\nWords.");
  });

  /** A site without a robots.txt, or one that can't be read, allows. */
  test.each<[string, Partial<WebResponse> | Error | undefined]>([
    ["missing", undefined],
    ["a server error", { status: 500, statusText: "Server Error", body: encoder.encode("User-agent: *\nDisallow: /") }],
    // Only a 200 is read as rules, as in the add-on.
    ["a partial answer", { status: 206, statusText: "Partial Content", body: encoder.encode("User-agent: *\nDisallow: /") }],
    ["unreachable", new Error("connection refused")],
  ])("a robots.txt %s allows", async (_name, robots) => {
    if (robots !== undefined) web.pages.set("https://example.com/robots.txt", robots);
    web.page("https://example.com/page", "Words.");

    expect(await reader.read(new URL("https://example.com/page"), signal)).toContain("Content:\nWords.");
  });

  /** A canceled request ends the read, robots.txt's included, rather than reading on or failing. */
  test.each(["https://example.com/robots.txt", "https://example.com/page"])("a cancel while %s is read ends it", async (url) => {
    web.page("https://example.com/page", "Words.");
    web.pages.set(url, new CancellationError());

    await expect(reader.read(new URL("https://example.com/page"), signal)).rejects.toBeInstanceOf(CancellationError);
  });

  test("a page that can't be fetched says why", async () => {
    web.pages.set("https://example.com/page", new Error("timed out after 30 seconds"));

    await expect(reader.read(new URL("https://example.com/page"), signal)).rejects.toEqual(new WebReadError("Failed to fetch URL: timed out after 30 seconds"));
  });

  test.each<[Partial<WebResponse>, string]>([
    [{ status: 404, statusText: "Not Found" }, "HTTP error: 404 Not Found"],
    [{ status: 301, statusText: "" }, "HTTP error: 301"],
    [{ status: 204, statusText: "No Content" }, "HTTP error: 204 No Content"],
  ])("a page answering %j fails", async (response, message) => {
    web.pages.set("https://example.com/page", { contentType: "text/html", body: encoder.encode("<p>x</p>"), ...response });

    await expect(reader.read(new URL("https://example.com/page"), signal)).rejects.toEqual(new WebReadError(message));
  });

  /** An HTML page is its text; XHTML too. */
  test.each(["text/html; charset=utf-8", "application/xhtml+xml"])("a %s page is read as its text", async (contentType) => {
    web.page("https://example.com/page", "<html><head><style>p{}</style></head><body><nav>Menu</nav><p>One &amp; two</p><p>Three</p></body></html>", contentType);

    expect(await reader.read(new URL("https://example.com/page"), signal)).toBe(`URL: https://example.com/page\nContent-Type: ${contentType}\nContent-Length: 16 characters\n\nContent:\nOne & two\n Three`);
  });

  test("a page without a type is plain text", async () => {
    web.page("https://example.com/page", "<p>As written</p>", null);

    expect(await reader.read(new URL("https://example.com/page"), signal)).toBe("URL: https://example.com/page\nContent-Type: text/plain\nContent-Length: 17 characters\n\nContent:\n<p>As written</p>");
  });

  /** The text is decoded in the charset the page names; one this runtime doesn't know is read as
   * UTF-8. */
  test.each<[string, Uint8Array, string]>([
    ["text/plain; charset=iso-8859-1", new Uint8Array([0x43, 0x61, 0x66, 0xe9]), "Café"],
    ['text/plain; charset="iso-8859-1"', new Uint8Array([0x4e, 0x61, 0xef, 0x76, 0x65]), "Naïve"],
    ["text/plain; charset=utf-16le", new Uint8Array([0x48, 0x00, 0x69, 0x00]), "Hi"],
    ["text/plain; charset=no-such-charset", encoder.encode("Café"), "Café"],
    ["text/plain", encoder.encode("Café"), "Café"],
  ])("%s is decoded", async (contentType, body, text) => {
    web.pages.set("https://example.com/page", { status: 200, statusText: "OK", contentType, body });

    expect((await reader.read(new URL("https://example.com/page"), signal)).split("Content:\n")[1]).toBe(text);
  });

  /** A page longer than the model gets is cut, as on Thunderbird; exactly that long is not. */
  test("a long page is cut", async () => {
    const most = config.webReadMaxCharacters;
    web.page("https://example.com/long", "x".repeat(most + 1));
    web.page("https://example.com/exact", "y".repeat(most));

    expect((await reader.read(new URL("https://example.com/long"), signal)).split("Content:\n")[1]).toBe("x".repeat(most));
    expect((await reader.read(new URL("https://example.com/exact"), signal)).split("Content:\n")[1]).toBe("y".repeat(most));
  });
});

describe("robots.txt", () => {
  const agent = config.webUserAgent;
  const allowed = (robots: string, path: string, userAgent = agent) => WebPageReader.isPathAllowed(robots, path, userAgent);

  test("nothing, or only comments, allows all", () => {
    expect(allowed("", "/anything")).toBe(true);
    expect(allowed("# User-agent: *\n# Disallow: /", "/anything")).toBe(true);
  });

  test("a disallowed prefix is refused, and case matters in paths but not in directives", () => {
    const robots = "USER-AGENT: *\nDISALLOW: /secret/\nDisallow: /api";
    expect(allowed(robots, "/secret/page")).toBe(false);
    expect(allowed(robots, "/secret/")).toBe(false);
    expect(allowed(robots, "/api-docs")).toBe(false);
    expect(allowed(robots, "/Secret/page")).toBe(true);
    expect(allowed(robots, "/public/")).toBe(true);
    expect(allowed(robots, "/")).toBe(true);
  });

  test("Disallow: / refuses all, and an empty Disallow allows all", () => {
    expect(allowed("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /", "/deep/path")).toBe(false);
    expect(allowed("User-agent: *\nDisallow:", "/anything")).toBe(true);
  });

  test("an Allow prefix wins over a Disallow one, and an empty Allow allows nothing", () => {
    const robots = "User-agent: *\nDisallow: /secret/\nAllow: /secret/public";
    expect(allowed(robots, "/secret/public")).toBe(true);
    expect(allowed(robots, "/secret/private")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /\nAllow:", "/page")).toBe(false);
  });

  /** Only the `*` group and this app's own apply: another agent's group sets aside the rules read so
   * far, and its own are not read. */
  test("another agent's rules don't apply", () => {
    expect(allowed("User-agent: OtherBot\nDisallow: /", "/page")).toBe(true);
    expect(allowed(`User-agent: ${agent}\nDisallow: /mine/`, "/mine/page")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a/\nUser-agent: OtherBot\nDisallow: /b/", "/a/page")).toBe(true);
    expect(allowed("User-agent: OtherBot\nDisallow: /b/\nUser-agent: *\nDisallow: /a/", "/b/page")).toBe(true);
    expect(allowed("User-agent: OtherBot\nDisallow: /b/\nUser-agent: *\nDisallow: /a/", "/a/page")).toBe(false);
  });

  test("Windows line ends, blank lines and stray spaces are read", () => {
    const robots = "User-agent: *\r\n\r\n   Disallow:   /blocked/   \r\nAllow: /open/\r\n";
    expect(allowed(robots, "/blocked/page")).toBe(false);
    expect(allowed(robots, "/open/")).toBe(true);
  });
});

describe("a page's text", () => {
  test("scripts, styles and page chrome go, whatever their case and attributes", () => {
    const html = '<SCRIPT type="x">var a = "<p>";</SCRIPT><header class="h">Top</header><main>Kept</main><aside>Side</aside><iframe src="x"></iframe><noscript>No</noscript><footer>Bottom</footer><style>\np {}\n</style>';
    expect(WebPageReader.text(html)).toBe("Kept");
  });

  test("block ends are line breaks, other tags spaces, and runs collapse", () => {
    expect(WebPageReader.text("<div>One</div><div>Two<br>Three<br/>Four</div><ul><li>Five</li></ul><span>Six</span>\t\t<b>Seven</b>")).toBe("One\n Two\nThree\nFour\n Five\n Six Seven");
    expect(WebPageReader.text("<p>A</p>\n\n\n\n<p>B</p>")).toBe("A\n\n B");
  });

  test("entities read as their characters, once", () => {
    expect(WebPageReader.text("&lt;b&gt; &quot;x&quot; &#39;y&apos; a&nbsp;b &#233; &#x1F600; &amp;lt;")).toBe("<b> \"x\" 'y' a b é 😀 &lt;");
  });

  test("an element left open keeps the text after it", () => {
    expect(WebPageReader.text("<p>A</p><script>x</script>B<script>never closed")).toBe("A\nB never closed");
  });

  /** A closing tag with no element open before it is only a tag: the text around it is kept, once. */
  test("a stray closing tag drops nothing", () => {
    expect(WebPageReader.text("A</script>B<script>x</script>C")).toBe("A BC");
  });

  /** Only the element itself: a custom element whose name starts with a chrome tag's is page text, and
   * a closing tag may have spaces before its `>`. */
  test("a custom element named like page chrome is kept, and a spaced closing tag closes", () => {
    expect(WebPageReader.text("<nav-menu>A</nav-menu><p>B</p><nav>M</nav>C")).toBe("A B\nC");
    expect(WebPageReader.text("<header-logo>Logo</header-logo><footer/>")).toBe("Logo");
    expect(WebPageReader.text("<script>x</script >After<style type=x>y</STYLE\n>End")).toBe("AfterEnd");
  });

  /** A hostile page must not stall the app: the extraction runs on the main process, which a regex
   * rescanning to the end from every unclosed `<` held for minutes on these (ADR-DESK-030). Each takes
   * milliseconds now; the deadline only has to sit far below minutes. */
  test.each([
    ["<", "<", ""],
    ["<script", "<script", ""],
    ["<script>", "<script>", ""],
    ["<nav a=b", "<NAV a=b", ""],
    ["<script> then one close", "<script>", "</script>"],
    ["<nav> then one close", "<nav>", "</nav>"],
    ["</script", "</script", ""],
  ])("a page of %s over and over is read in time", (_name, unit, end) => {
    const html = unit.repeat(Math.floor((config.webReadMaxCharacters - end.length) / unit.length)) + end;
    const start = performance.now();
    WebPageReader.text(html);
    expect(performance.now() - start).toBeLessThan(config.webReadMaxCharacters / 100);
  });

  /** A numeric entity naming no character stays as written. */
  test.each(["&#1114112;", "&#xD800;", "&#x110000;"])("%s stays", (entity) => {
    expect(WebPageReader.text(`a ${entity} b`)).toBe(`a ${entity} b`);
  });
});

describe("web_open", () => {
  test("the page opens in the browser", async () => {
    const opened: string[] = [];
    const tool = new WebOpenTool({ open: async (url) => void opened.push(url) });

    expect(await tool.run({ url: "https://example.com/page" })).toBe("Opened https://example.com/page in the browser.");
    expect(opened).toEqual(["https://example.com/page"]);
  });

  /** A page the browser can't open fails the call, for the model to be told, never "Opened". */
  test("a failed open is reported", async () => {
    const tool = new WebOpenTool({ open: async () => Promise.reject(new Error("no browser")) });

    await expect(tool.run({ url: "https://example.com/page" })).rejects.toThrow("no browser");
  });

  test.each([{ url: "shortcuts://run-shortcut?name=Example" }, { url: "file:///etc/hosts" }, {}])("%j opens nothing", async (args) => {
    const opened: string[] = [];
    const tool = new WebOpenTool({ open: async (url) => void opened.push(url) });

    await expect(tool.run(args)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(opened).toEqual([]);
  });
});

/** The real fetch, against a server on this computer. */
describe("liveWebFetch", () => {
  let server: Server;
  let base: string;
  let handle: (request: IncomingMessage, response: ServerResponse) => void;
  const seen: IncomingMessage[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = createServer((request, response) => {
      seen.push(request);
      handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("a page comes back with its status, type and bytes, asked with the headers given", async () => {
    handle = (_request, response) => {
      response.writeHead(200, "OK", { "Content-Type": "text/html; charset=iso-8859-1" });
      response.end(Buffer.from([0x43, 0x61, 0x66, 0xe9]));
    };

    const response = await liveWebFetch(`${base}/page`, { "User-Agent": config.webUserAgent }, 5_000, signal);

    expect(response).toEqual({ status: 200, statusText: "OK", contentType: "text/html; charset=iso-8859-1", body: new Uint8Array([0x43, 0x61, 0x66, 0xe9]) });
    expect(seen[0]?.headers["user-agent"]).toBe(config.webUserAgent);
  });

  test("an error status comes back as it is", async () => {
    handle = (_request, response) => {
      response.writeHead(404, "Not Found");
      response.end();
    };

    expect(await liveWebFetch(`${base}/missing`, {}, 5_000, signal)).toMatchObject({ status: 404, statusText: "Not Found", body: new Uint8Array() });
  });

  /** An endless page is read to `webReadMaxBytes` and no further: the page never ends, so a read
   * that didn't stop would never come back. */
  test("an endless body is read up to the cap", async () => {
    handle = (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      const write = () => {
        while (!response.destroyed && response.write("x".repeat(1_024)));
        if (!response.destroyed) response.once("drain", write);
      };
      write();
    };

    // Long enough that only the reader's cancel, not the timeout, ends the connection in the test.
    const response = await liveWebFetch(`${base}/endless`, {}, 60_000, signal);

    expect(response.body).toEqual(encoder.encode("x".repeat(config.webReadMaxBytes)));
    // The page is let go once read, not left streaming until the timeout.
    const closed = new Promise<boolean>((resolve) => {
      if (seen[0]?.socket.destroyed) resolve(true);
      seen[0]?.socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 10_000);
    });
    expect(await closed).toBe(true);
  });

  test("a redirect is followed", async () => {
    handle = (request, response) => {
      if (request.url === "/old") {
        response.writeHead(302, { Location: "/new" });
        response.end();
      } else {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("Moved here.");
      }
    };

    const response = await liveWebFetch(`${base}/old`, {}, 5_000, signal);

    expect(response).toMatchObject({ status: 200, body: encoder.encode("Moved here.") });
    expect(seen.map((request) => request.url)).toEqual(["/old", "/new"]);
  });

  /** fetch gives no body at all for a 204. */
  test("a page without a body comes back empty", async () => {
    handle = (_request, response) => {
      response.writeHead(204, "No Content");
      response.end();
    };

    expect(await liveWebFetch(`${base}/empty`, {}, 5_000, signal)).toMatchObject({ status: 204, statusText: "No Content", body: new Uint8Array() });
  });

  test("a page that doesn't answer in time fails", async () => {
    handle = () => {};

    await expect(liveWebFetch(`${base}/slow`, {}, 200, signal)).rejects.toThrow("timed out after 0.2 seconds");
  });

  test("a cancel ends the request", async () => {
    handle = () => {};
    const controller = new AbortController();

    const request = liveWebFetch(`${base}/slow`, {}, 5_000, controller.signal);
    setTimeout(() => controller.abort(), 100);

    await expect(request).rejects.toBeInstanceOf(CancellationError);
  });

  test("a request already canceled asks nothing", async () => {
    handle = (_request, response) => response.end();
    const controller = new AbortController();
    controller.abort();

    await expect(liveWebFetch(`${base}/page`, {}, 5_000, controller.signal)).rejects.toBeInstanceOf(CancellationError);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual([]);
  });

  test("a server that isn't there fails", async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    await expect(liveWebFetch(`${base}/page`, {}, 5_000, signal)).rejects.toThrow();
  });
});
