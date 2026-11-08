// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { licences, packageOf } from "../../scripts/browser-pages.mts";
import { correctionMaxFieldLength } from "../../src/core/config.ts";
import { knownFailures, sometimesFailing, type PageReport } from "../../native/shared/browser-pages/checks.mjs";
import { cases, lines, type Page, type Size } from "../../native/shared/browser-pages/document.mjs";
import { fieldMaxLength, pageChannel, readPages, RequestTimeoutError, rpc, timing, type Browser, type Command, type Helper, type Helpers, type PageChannel } from "../../native/shared/browser-pages/driver.mjs";

const policy = { excludedAppIDs: [], excludedHosts: [] };

/** Where the stand-in page sits on the screen, and how far from its caret the stand-in helpers put
 * the anchor (the page's content's place on the screen). */
const screen = { x: 100, y: 50, frameX: 0, frameY: 80 };
const content = { x: 100, y: 130 };

/** A screen reader over the real request wire (`rpc`, with its own timer): it answers each read as the
 * world says, and none the world gives as a `RequestTimeoutError` (the read runs on, never answered in time);
 * it answers a stop, refuses it, or never answers it (`stop`). `sent` is every line the driver wrote
 * to it, in order, and `unanswered` the reads it never answered. */
interface Wire {
  request: number;
  stop: "answer" | "refuse" | "silent";
  sent: { method: string; params: { read?: number } }[];
  unanswered: number[];
  /** The reads the helper answered with an error reply, and how it answered each stop. */
  refused: number[];
  stopsAnswered: Wire["stop"][];
}
function wired(wire: Wire, read: (params: unknown) => unknown, stopped: (params: unknown) => void): Helper {
  const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true };
  createInterface({ input: child.stdin }).on("line", (line) => {
    const { id, method, params } = JSON.parse(line) as { id: number; method: string; params: { read?: number } };
    wire.sent.push({ method, params });
    // What went back on the wire, as it went.
    let answered = "silent" as Wire["stop"];
    const reply = (body: object) => {
      answered = "error" in body ? "refuse" : "answer";
      child.stdout.write(`${JSON.stringify({ id, ...body })}\n`);
    };
    if (method === "readScreenStop") {
      stopped(params);
      if (wire.stop === "answer") reply({ result: null });
      else if (wire.stop === "refuse") reply({ error: { message: "refused" } });
      wire.stopsAnswered.push(answered);
      return;
    }
    const answer = read(params);
    if (answer instanceof RequestTimeoutError) wire.unanswered.push(params.read ?? 0);
    else if (answer instanceof Error) reply({ error: { message: answer.message } });
    else reply({ result: answer });
    if (answered === "refuse") wire.refused.push(params.read ?? 0);
  });
  return rpc("voice-screen-reader", child, { request: wire.request, log: () => undefined });
}

/** The driver's screen reads on a wire, in order: each one's number, and whether its next request to
 * the reader was a stop naming it. */
function stopsOnTheWire(wire: Wire) {
  const reads = wire.sent.filter(({ method }) => method === "readScreen").map(({ params }) => params.read);
  const stopped = wire.sent.flatMap(({ method, params }, index) => (method === "readScreen" && wire.sent[index + 1]?.method === "readScreenStop" && wire.sent[index + 1]?.params.read === params.read ? [params.read] : []));
  const stops = wire.sent.filter(({ method }) => method === "readScreenStop").map(({ params }) => params.read);
  return { reads, stopped, stops };
}

/** A page in a browser, the helpers reading it, and everything each was asked, in order. */
function world(options: { platform?: string; selected?: (command: Command, text: string) => string; screen?: (read: object, count: number, key: string) => object | null; anchor?: (count: number, right: object | null) => object | Error | null; shellAnchor?: object | null; field?: (count: number, right: object, sincePlaced: number) => object | Error | null; loads?: boolean; wire?: Wire } = {}) {
  const events: string[] = [];
  const requests: { helper: string; method: string; params: unknown }[] = [];
  // Requests outside what each helper is asked for reading (a clipboard request, say), which no run may make.
  const forbidden: string[] = [];
  // The driver's waits, on a clock of their own: how long it waited, and when each caret was placed.
  const waits: number[] = [];
  let now = 0;
  let placedAt = 0;
  let current: { page: Page; size: Size } = { page: "codemirror", size: "short" };
  let placed: Command | null = null;
  const counts = new Map<string, number>();
  const count = (key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts.get(key) ?? 0;
  };
  /** The caret's rectangle in the page: eight pixels a character, twenty a line. */
  const rect = (line: number, offset: number) => ({ x: offset * 8, y: line * 20, height: 16 });
  const channel: PageChannel = {
    ask: () => undefined,
    report: () => undefined,
    deliver: (command) => { events.push(`deliver ${command.kind}`); },
    send: (command) => {
      events.push(`select ${command.line} ${command.from} ${command.to}`);
      placed = command;
      placedAt = now;
      const text = lines(current.page, current.size)[command.line ?? 0] ?? "";
      const report: PageReport = {
        selected: options.selected ? options.selected(command, text) : text.slice(command.from, command.to),
        caret: rect(command.line ?? 0, command.to ?? 0),
        start: rect(command.line ?? 0, command.from ?? 0),
        scale: 1,
        screen,
      };
      return Promise.resolve(report);
    },
    open: () => (options.loads === false ? new Promise(() => undefined) : Promise.resolve({ ready: true })),
  };
  const key = () => `${current.page} ${current.size} ${placed?.line} ${placed?.from} ${placed?.to}`;
  const helper = (name: string, methods: string[], answer: (method: string, params: unknown) => unknown): Helper => ({
    child: { kill: () => { events.push(`kill ${name}`); } },
    request: (method, params = {}) => {
      events.push(`${name} ${method}`);
      requests.push({ helper: name, method, params });
      if (!methods.includes(method)) {
        forbidden.push(`${name} ${method}`);
        return Promise.reject(new Error(`${name} is not asked ${method}`));
      }
      const reply = answer(method, params);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  });
  /** The right caret context for the caret placed. */
  const rightScreen = () => {
    const text = lines(current.page, current.size);
    const line = placed?.line ?? 0;
    return {
      // Edge, the browser read: Linux records no reads of it as failing. The Windows helper names an app
      // by its program alone, with no bundle ID.
      ...(options.platform === "win32" ? { bundleID: null, appName: "msedge.exe" } : { bundleID: "microsoft-edge.desktop", appName: "Microsoft Edge" }),
      textBeforeCaret: `${text.slice(0, line).join("\n")}\n${(text[line] ?? "").slice(0, placed?.from)}`,
      selectedText: (text[line] ?? "").slice(placed?.from, placed?.to),
      textAfterCaret: `${(text[line] ?? "").slice(placed?.to)}\n${text.slice(line + 1).join("\n")}`,
    };
  };
  let started = 0;
  const startHelpers = (): Helpers => {
    started += 1;
    events.push("start helpers");
    const helpers: Helpers = {
      main: helper("main", ["frontmostApp", "caretAnchor"], (method) => {
        if (method === "frontmostApp") return { pid: 42, window: 7 };
        const right = placed ? { x: content.x + (placed.to ?? 0) * 8, y: content.y + (placed.line ?? 0) * 20, height: 16 } : null;
        return options.anchor ? options.anchor(count(`anchor ${key()}`), right) : right;
      }),
      reader: options.wire ? wired(options.wire, (params) => {
        requests.push({ helper: "reader", method: "readScreen", params });
        events.push("reader readScreen");
        const read = rightScreen();
        return options.screen ? options.screen(read, count(`screen ${key()}`), key()) : read;
      }, (params) => {
        requests.push({ helper: "reader", method: "readScreenStop", params });
        events.push("reader readScreenStop");
      }) : helper("reader", ["readScreen", "readScreenStop"], (method) => {
        if (method === "readScreenStop") return null;
        const read = rightScreen();
        return options.screen ? options.screen(read, count(`screen ${key()}`), key()) : read;
      }),
      fieldReader: helper("field", ["focusedFieldValue"], () => {
        const right = { value: lines(current.page, current.size).join("\n") };
        return options.field ? options.field(count(`field ${key()}`), right, now - placedAt) : right;
      }),
      shell: options.platform === "win32" ? null : helper("shell", ["caretAnchor"], () => options.shellAnchor ?? null),
      stop: () => { events.push("stop helpers"); },
    };
    return helpers;
  };
  const windows: { url: string; activated: number; closed: boolean }[] = [];
  const launch = (_browser: Browser, url: string) => {
    const [page, size] = /\/(\w+)\.html\?size=(\w+)/.exec(url)?.slice(1) ?? [];
    current = { page: page as Page, size: size as Size };
    placed = null;
    const window = { url, activated: 0, closed: false };
    windows.push(window);
    events.push(`launch ${url}`);
    return {
      activate: () => { window.activated += 1; events.push("activate"); },
      close: () => { window.closed = true; events.push("close"); return Promise.resolve(); },
    };
  };
  const output: string[] = [];
  const run = (browser: Browser["name"] = "edge") => readPages({
    platform: options.platform ?? "linux",
    browsers: [{ name: browser, path: "/browser" }],
    startHelpers,
    launch,
    channel,
    url: (page, size) => `http://page/${page}.html?size=${size}`,
    write: (line) => { output.push(line); },
    wait: (ms) => { waits.push(ms); now += ms; return Promise.resolve(); },
    // A page that never loads fails at once.
    times: { ...timing, page: options.loads === false ? 1 : timing.page },
  });
  return { run, events, requests, forbidden, waits, windows, output, started: () => started };
}

/** Every read the driver makes of a browser's pages, in the order it makes them. */
function every(browser: string): string[] {
  return (["codemirror", "compose"] as const).flatMap((page) => (["short", "long"] as const).flatMap((size) => [
    `${browser} ${page} ${size}-document identity`,
    ...cases(page).filter((each) => each.size === size).flatMap(({ name }) => [`${browser} ${page} ${name} readScreen`, `${browser} ${page} ${name} focusedFieldValue`]),
    ...cases(page).filter((each) => each.size === size).map(({ name }) => `${browser} ${page} ${name} caretAnchor`),
  ]));
}

describe("the browser-page driver", () => {
  test("reads every case of every page three ways, a selection's anchor too, and passes when every read is right", async () => {
    const { run, events, forbidden, windows, output } = world();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run();
      // No timer left behind to keep the run going once its last page is read.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    events.length = 0;
    windows.length = 0;
    output.length = 0;
    const { results, status } = await run();
    expect(results.map(({ key }) => key)).toEqual(every("edge"));
    expect(results.filter(({ key }) => key.includes("selection")).map(({ key }) => key.split(" ").at(-1))).toEqual(["readScreen", "focusedFieldValue", "caretAnchor", "readScreen", "focusedFieldValue", "caretAnchor"]);
    expect(results.every(({ outcome }) => outcome === "pass")).toBe(true);
    expect(status).toBe(0);
    expect(output.at(-1)).toBe("46 of 46 reads as expected\n");
    // Each page opened in its own window, closed after; the helpers started once and stopped at the end.
    expect(windows.map(({ url, closed }) => [url, closed])).toEqual([
      ["http://page/codemirror.html?size=short", true], ["http://page/codemirror.html?size=long", true],
      ["http://page/compose.html?size=short", true], ["http://page/compose.html?size=long", true],
    ]);
    expect(events.filter((each) => each.endsWith("helpers"))).toEqual(["start helpers", "stop helpers"]);
    expect(events.filter((each) => each === "deliver done")).toHaveLength(4);
    expect(events).not.toContain("activate");
    // Nothing but reads: no request that touches the clipboard, keys or windows.
    expect(forbidden).toEqual([]);
  });

  test("asks for a field as long as the app does", () => {
    expect(fieldMaxLength).toBe(correctionMaxFieldLength);
  });

  test("puts each case's caret in the page before reading it, and asks the helpers as the app does on Linux", async () => {
    const { run, events, requests } = world();
    await run();
    const short = cases("codemirror").filter((each) => each.size === "short");
    // The first page: brought to the front with its first case's caret, then each case placed and read in turn.
    const first = events.slice(events.indexOf("launch http://page/codemirror.html?size=short") + 1, events.indexOf("launch http://page/codemirror.html?size=long"));
    const placements = first.filter((each) => each.startsWith("select "));
    expect(placements).toEqual([short[0]!, ...short].map(({ line, from, to }) => `select ${line} ${from} ${to}`));
    // Each placed caret is read, then the next placed: the main helper's anchor right, the Shell is not asked.
    let at = first.findIndex((each) => each.startsWith("select "));
    for (const { line, from, to } of short) {
      at = first.indexOf(`select ${line} ${from} ${to}`, at + 1);
      expect(first.slice(at + 1, at + 5)).toEqual(["reader readScreen", "main frontmostApp", "field focusedFieldValue", "main caretAnchor"]);
    }
    expect(first.at(-2)).toBe("deliver done");
    expect(first.at(-1)).toBe("close");
    const asked = (method: string) => requests.filter((each) => each.method === method);
    // Each screen read is numbered, as the app numbers its reads, so one can be asked to stop.
    expect(asked("readScreen").map(({ helper, params }) => ({ helper, params }))).toEqual(asked("readScreen").map((_, index) => ({ helper: "reader", params: { ...policy, read: index + 1 } })));
    expect(asked("focusedFieldValue").every(({ helper, params }) => helper === "field" && JSON.stringify(params) === JSON.stringify({ ...policy, pid: 42, maxLength: fieldMaxLength }))).toBe(true);
    expect(asked("caretAnchor").every(({ helper, params }) => helper === "main" && JSON.stringify(params) === "{}")).toBe(true);
  });

  test("on Linux, takes the Shell's caret where the main helper has none", async () => {
    const shellAnchor = { x: 1, y: 2, height: 16 };
    const { run, requests, output } = world({ anchor: () => null, shellAnchor });
    const { results } = await run();
    expect(requests.filter(({ method }) => method === "caretAnchor").map(({ helper }) => helper).slice(0, 2)).toEqual(["main", "shell"]);
    // Every anchor the same place, which the page's carets are not: judged wrong, by the Shell's anchor.
    expect(results.filter(({ key, outcome }) => key.endsWith("caretAnchor") && outcome === "fail").length).toBeGreaterThan(0);
    expect(output.some((line) => line.startsWith("FAIL edge codemirror line-start caretAnchor: anchor"))).toBe(true);
  });

  test("on Linux, takes the Shell's caret where the main helper's request fails, as the app does", async () => {
    const first = cases("codemirror")[0]!;
    const { run, requests, output } = world({ anchor: () => new Error("main caretAnchor timed out"), shellAnchor: { x: 1, y: 2, height: 16 } });
    const { results } = await run();
    expect(requests.filter(({ method }) => method === "caretAnchor").map(({ helper }) => helper).slice(0, 2)).toEqual(["main", "shell"]);
    // The first anchor is the Shell's, and right: every other caret is judged against it.
    expect(results.find(({ key }) => key === `edge codemirror ${first.name} caretAnchor`)?.outcome).toBe("pass");
    expect(output).not.toContain(`FAIL edge codemirror ${first.name} caretAnchor: no caret anchor\n`);
  });

  test("on Windows, activates the browser's window and asks for the window in front, judging anchors on the screen", async () => {
    const { run, requests, windows } = world({ platform: "win32" });
    const { results, status } = await run("edge");
    expect(windows.every(({ activated }) => activated === 1)).toBe(true);
    const asked = (method: string) => requests.filter((each) => each.method === method);
    expect(asked("focusedFieldValue").every(({ params }) => JSON.stringify(params) === JSON.stringify({ ...policy, window: 7, maxLength: fieldMaxLength }))).toBe(true);
    expect(asked("caretAnchor").every(({ helper, params }) => helper === "main" && JSON.stringify(params) === JSON.stringify({ window: 7 }))).toBe(true);
    // Every read right: Edge has no read recorded as always failing, so the run passes.
    for (const { key, outcome } of results) {
      const issue = knownFailures.win32?.[key];
      expect(outcome, key).toBe(issue && !sometimesFailing.has(issue) ? "fixed" : "pass");
    }
    expect(status).toBe(0);
  });

  test("on Windows, an anchor as far from every caret but not where the page is on the screen is wrong", async () => {
    const { run } = world({ platform: "win32", anchor: () => ({ x: 400, y: 400, height: 16 }) });
    const { results } = await run("edge");
    expect(results.filter(({ key }) => key.endsWith("caretAnchor")).every(({ outcome }) => outcome === "fail")).toBe(true);
  });

  test("an anchor the browser has not moved yet is asked again, and passes once it is where the caret is", async () => {
    const { run, requests } = world({ platform: "win32", anchor: (count, right) => (count === 1 && right ? { ...right, x: (right as { x: number }).x + 200 } : right) });
    const { results } = await run("edge");
    for (const { key, outcome } of results.filter(({ key }) => key.endsWith("caretAnchor"))) {
      const issue = knownFailures.win32?.[key];
      expect(outcome, key).toBe(issue && !sometimesFailing.has(issue) ? "fixed" : "pass");
    }
    expect(requests.filter(({ method }) => method === "caretAnchor")).toHaveLength(2 * 14);
  });

  test("a read still wrong is tried again a bounded number of times, then fails the run", async () => {
    const midLine = cases("codemirror").find(({ name }) => name === "mid-line");
    let tries = 0;
    const { run, output } = world({
      screen: (read, count, key) => {
        if (key !== `codemirror short ${midLine?.line} ${midLine?.from} ${midLine?.to}`) return read;
        tries = count;
        return { ...read, selectedText: "x" };
      },
    });
    const { results, status } = await run();
    expect(tries).toBe(timing.tries);
    expect(results.find(({ key }) => key === "edge codemirror mid-line readScreen")?.outcome).toBe("fail");
    expect(output).toContain("FAIL edge codemirror mid-line readScreen: selected \"x\", not \"\"\n");
    expect(status).toBe(1);
  });

  test("a read the browser catches up with is tried until it is right, and passes", async () => {
    const { run, requests } = world({ field: (count, right) => (count < 3 ? null : right) });
    const { results, status } = await run();
    expect(results.every(({ outcome }) => outcome === "pass")).toBe(true);
    expect(status).toBe(0);
    expect(requests.filter(({ method }) => method === "focusedFieldValue")).toHaveLength(3 * 14);
  });

  test("a request the helper refuses is tried again like one with no answer, and passes once it is answered", async () => {
    const refused = new Error("the field reader refused");
    const { run, requests, started } = world({ field: (count, right) => (count < 3 ? refused : right) });
    const { results, status } = await run();
    expect(results.every(({ outcome }) => outcome === "pass")).toBe(true);
    expect(status).toBe(0);
    // Two refusals, then the answer, for each of the 14 cases, with the same helpers throughout.
    expect(requests.filter(({ method }) => method === "focusedFieldValue")).toHaveLength(3 * 14);
    expect(started()).toBe(1);
  });

  test("a screen read not answered in time is asked to stop by its number, so the next read does not wait behind it", async () => {
    // The first read for each caret placed (the check that the browser is in front, then each case's
    // caret read) is never answered: the request's own timer gives it up. The next is answered.
    for (const platform of ["linux", "win32"]) {
      const wire: Wire = { request: 5, stop: "answer", sent: [], unanswered: [], refused: [], stopsAnswered: [] };
      const { run, started } = world({ platform, wire, screen: (read, count) => (count === 1 ? new RequestTimeoutError("never answered") : read) });
      const { results, status } = await run();
      // Every read is right in the end (on Windows, those recorded as failing for other issues are fixed).
      expect(results.filter(({ outcome }) => outcome === "fail"), platform).toEqual([]);
      if (platform === "linux") expect(status).toBe(0);
      const { reads, stopped, stops } = stopsOnTheWire(wire);
      // One read a case went unanswered, from both callers: the front check's, of each page's first
      // case, and the caret read's of every other case.
      expect(wire.unanswered).toHaveLength(14);
      // Every read given up is stopped by its number before anything else is asked of the reader, and
      // only those are; reads are numbered in order.
      expect(stopped).toEqual(wire.unanswered);
      expect(stops).toEqual(wire.unanswered);
      expect(reads).toEqual(reads.map((_, index) => index + 1));
      expect(started()).toBe(1);
    }
  });

  test("a stop refused or never answered still lets the run go on, and the read is reported as timed out", async () => {
    for (const stop of ["refuse", "silent"] as const) {
      // No read is ever answered: the browser never comes to the front, every page fails on the
      // timeout, and each read is stopped.
      const wire: Wire = { request: 2, stop, sent: [], unanswered: [], refused: [], stopsAnswered: [] };
      const { run, output } = world({ wire, screen: () => new RequestTimeoutError("never answered") });
      const { results, status } = await run();
      expect(results.map(({ outcome }) => outcome)).toEqual(["fail", "fail", "fail", "fail"]);
      expect(status).toBe(1);
      expect(output[0]).toBe("FAIL edge codemirror short-document: edge never came to the front; the last read was voice-screen-reader readScreen timed out\n");
      const { stopped } = stopsOnTheWire(wire);
      expect(stopped).toEqual(wire.unanswered);
      expect(wire.unanswered).toHaveLength(4 * timing.front);
      // Every stop was refused, or never answered.
      expect(wire.stopsAnswered).toEqual(Array(4 * timing.front).fill(stop));
    }
  });

  test("a screen read refused is not asked to stop: only one not answered in time is", async () => {
    // The helper answers the first read of each caret placed with an error reply, on the real wire.
    const wire: Wire = { request: 5, stop: "answer", sent: [], unanswered: [], refused: [], stopsAnswered: [] };
    const { run } = world({ wire, screen: (read, count) => (count === 1 ? new Error("refused") : read) });
    const { results, status } = await run();
    expect(results.every(({ outcome }) => outcome === "pass")).toBe(true);
    expect(status).toBe(0);
    const { reads, stops } = stopsOnTheWire(wire);
    // Each case's refused read was tried again and answered; none went unanswered, none was stopped.
    // One read refused for each caret placed, each a read the driver made.
    expect(wire.refused).toHaveLength(14);
    expect(wire.refused.every((read) => reads.includes(read))).toBe(true);
    expect(wire.unanswered).toEqual([]);
    expect(stops).toEqual([]);
  });

  test("a request refused every time fails that read alone, after its tries, and every other read is still made", async () => {
    const { run, requests, output, started } = world({ field: () => new Error("the field reader refused") });
    const { results, status } = await run();
    expect(status).toBe(1);
    expect(requests.filter(({ method }) => method === "focusedFieldValue")).toHaveLength(timing.tries * 14);
    expect(results.filter(({ key }) => key.endsWith(" focusedFieldValue")).map(({ outcome }) => outcome)).toEqual(Array(14).fill("fail"));
    expect(results.filter(({ key }) => !key.endsWith(" focusedFieldValue")).every(({ outcome }) => outcome === "pass")).toBe(true);
    expect(results.map(({ key }) => key)).toEqual(every("edge"));
    expect(output.filter((line) => line.includes("-document:"))).toEqual([]);
    expect(started()).toBe(1);
  });

  test("each read waits for the browser before it is made, and between its tries, so a browser that catches up in time passes", async () => {
    // The field is right only a second after its caret is placed: the screen read waits once, the field
    // read once and then between tries, until it is.
    const caughtUp = timing.settle * 2 + timing.retry * 2;
    const { run, waits } = world({ field: (_count, right, sincePlaced) => (sincePlaced >= caughtUp ? right : null) });
    const { results, status } = await run();
    expect(results.every(({ outcome }) => outcome === "pass")).toBe(true);
    expect(status).toBe(0);
    expect(timing.settle).toBeGreaterThan(0);
    expect(timing.retry).toBeGreaterThan(0);
    const placedAndRead = [timing.settle, timing.settle, timing.retry, timing.retry, timing.settle];
    expect(waits.join(" ")).toContain(placedAndRead.join(" "));
  });

  test("an anchor not read at once is asked again; one never read is no caret anchor", async () => {
    const { run, requests, output } = world({ anchor: () => null });
    const { status } = await run();
    expect(requests.filter(({ helper, method }) => helper === "main" && method === "caretAnchor")).toHaveLength(timing.tries * 14);
    expect(output).toContain("FAIL edge codemirror selection caretAnchor: no caret anchor\n");
    expect(status).toBe(1);
  });

  test("on Linux, an app the helpers can't name is taken as the browser in front: its identity read fails alone, and every case is still read", async () => {
    const { run } = world({ screen: (read) => ({ ...read, bundleID: "", appName: "Unknown" }) });
    const { results } = await run("chrome");
    for (const { key, outcome } of results.filter(({ key }) => key.endsWith("identity"))) expect(outcome, key).toBe(knownFailures.linux?.[key] ? "known" : "fail");
    expect(results.map(({ key }) => key)).toEqual(every("chrome"));
    // Every case read right: those recorded as failing for other issues are fixed.
    for (const { key, outcome } of results.filter(({ key }) => key.endsWith("readScreen"))) expect(outcome, key).toBe(knownFailures.linux?.[key] ? "fixed" : "pass");
  });

  test("a read recorded as failing that passes fails the run, and one that fails as recorded does not", async () => {
    const linux = knownFailures.linux ?? {};
    const fixed = "edge compose line-start readScreen";
    expect(linux[fixed]).toBeUndefined();
    linux[fixed] = 362;
    try {
      const { run, output } = world();
      const { results, status } = await run();
      expect(results.find(({ key }) => key === fixed)?.outcome).toBe("fixed");
      expect(output).toContain(`FIXED ${fixed}\n`);
      expect(output.at(-1)).toBe("45 of 46 reads as expected\n");
      expect(status).toBe(1);
      const known = world({ screen: (read) => ({ ...read, textAfterCaret: "" }) });
      const recorded = Object.fromEntries((await known.run()).results.map(({ key, outcome }) => [key, outcome]));
      expect(recorded[fixed]).toBe("known");
    } finally {
      delete linux[fixed];
    }
  });

  test("a page whose reads cannot go on is one failure: its window is closed, the helpers start afresh, and the next page is read", async () => {
    const { run, events, requests, windows, output, started } = world({ selected: (command, text) => (command.line === 13 && text === "" ? "stray" : text.slice(command.from, command.to)) });
    const { results, status } = await run();
    expect(output).toContain("FAIL edge codemirror short-document: edge codemirror empty-line: the page selected \"stray\", not \"\"\n");
    expect(results.filter(({ key }) => key.startsWith("edge codemirror short-document"))).toHaveLength(2);
    expect(windows.every(({ closed }) => closed)).toBe(true);
    // Both short pages (their empty line is the 14th) fail; each time the helpers start afresh.
    expect(results.map(({ key }) => key).filter((key) => key.endsWith("-document"))).toEqual(["edge codemirror short-document", "edge compose short-document"]);
    expect(started()).toBe(3);
    expect(events.filter((each) => each === "stop helpers")).toHaveLength(3);
    // The screen reads are numbered in order across the helpers started afresh, never one number twice.
    const numbers = requests.filter(({ method }) => method === "readScreen").map(({ params }) => (params as { read: number }).read);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    // The long page after it is still read whole.
    expect(results.filter(({ key }) => key.startsWith("edge codemirror long-") && key !== "edge codemirror long-document identity")).toHaveLength(6);
    expect(status).toBe(1);
  });

  test("a browser that never comes to the front, or a page that never loads, fails its page", async () => {
    const behind = world({ platform: "win32", screen: () => ({ bundleID: null, appName: "notepad.exe" }) });
    const { results } = await behind.run("edge");
    expect(results.map(({ key }) => key)).toEqual(["edge codemirror short-document", "edge codemirror long-document", "edge compose short-document", "edge compose long-document"]);
    expect(behind.output[0]).toBe("FAIL edge codemirror short-document: edge never came to the front; the last read was \"notepad.exe\" (null)\n");
    expect(behind.windows.every(({ activated }) => activated === timing.front)).toBe(true);
    // Whatever stops a page fails the run, never recorded as an issue's read: on Windows too, the long compose page's.
    expect(results.every(({ outcome }) => outcome === "fail")).toBe(true);
    const stray = world({ platform: "win32", selected: () => "stray" });
    const strayRun = await stray.run("edge");
    expect(strayRun.results.map(({ key, outcome }) => `${key} ${outcome}`)).toEqual(["codemirror short", "codemirror long", "compose short", "compose long"]
      .flatMap((page) => [`edge ${page}-document identity pass`, `edge ${page}-document fail`]));
    expect(strayRun.status).toBe(1);
    const unloadedOnWindows = world({ platform: "win32", loads: false });
    const unloadedRun = await unloadedOnWindows.run("edge");
    expect(unloadedRun.results.map(({ outcome }) => outcome)).toEqual(["fail", "fail", "fail", "fail"]);
    const unread = world({ screen: () => new Error("reader timed out") });
    expect((await unread.run()).results[0]?.key).toBe("edge codemirror short-document");
    expect(unread.output[0]).toBe("FAIL edge codemirror short-document: edge never came to the front; the last read was reader timed out\n");
    const unloaded = world({ loads: false });
    const { status, results: unloadedResults } = await unloaded.run();
    expect(unloadedResults.every(({ outcome }) => outcome === "fail")).toBe(true);
    expect(unloaded.output[0]).toBe("FAIL edge codemirror short-document: codemirror did not load in edge\n");
    expect(status).toBe(1);
  });

  test("a screen read naming another app while the caret is read stops the page", async () => {
    const { run, output } = world({ screen: (read, count) => (count === 1 ? read : { ...read, bundleID: "org.gnome.Terminal.desktop", appName: "Terminal" }) });
    await run();
    expect(output[1]).toBe("FAIL edge codemirror short-document: edge is not in front (Terminal)\n");
    // On Windows too, where the app is named by its program alone.
    const windows = world({ platform: "win32", screen: (read, count) => (count === 1 ? read : { ...read, bundleID: null, appName: "notepad.exe" }) });
    await windows.run("edge");
    expect(windows.output[1]).toBe("FAIL edge codemirror short-document: edge is not in front (notepad.exe)\n");
  });
});

describe("a helper's requests", () => {
  const fake = () => {
    const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true };
    const sent: { id: number; method: string; params: unknown }[] = [];
    child.stdin.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) sent.push(JSON.parse(line) as { id: number; method: string; params: unknown }); });
    return { child, sent };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  test("each request is a JSON line with its own id, answered by the reply naming it", async () => {
    const { child, sent } = fake();
    const helper = rpc("voice-linux", child);
    const first = helper.request("frontmostApp");
    const second = helper.request("caretAnchor", { window: 7 });
    await tick();
    expect(sent).toEqual([{ id: 1, method: "frontmostApp", params: {} }, { id: 2, method: "caretAnchor", params: { window: 7 } }]);
    child.stdout.write(`${JSON.stringify({ id: 2, result: { x: 1 } })}\n${JSON.stringify({ id: 1, result: { pid: 3 } })}\n`);
    await expect(first).resolves.toEqual({ pid: 3 });
    await expect(second).resolves.toEqual({ x: 1 });
  });

  test("a request answered, or refused, leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { child } = fake();
      const helper = rpc("voice-linux", child);
      const answered = helper.request("frontmostApp");
      const refused = helper.request("caretAnchor");
      expect(vi.getTimerCount()).toBe(2);
      child.stdout.write(`${JSON.stringify({ id: 1, result: { pid: 3 } })}\n${JSON.stringify({ id: 2, error: { message: "refused" } })}\n`);
      await expect(answered).resolves.toEqual({ pid: 3 });
      await expect(refused).rejects.toThrow("voice-linux caretAnchor: refused");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an error reply or no reply in time rejects; the helper's stderr is passed on, named", async () => {
    const { child } = fake();
    const logged: string[] = [];
    const helper = rpc("voice-screen-reader", child, { log: (line) => logged.push(line), request: 20 });
    const refused = helper.request("readScreen");
    await tick();
    child.stdout.write(`${JSON.stringify({ id: 1, error: { message: "refused" } })}\n`);
    await expect(refused).rejects.toThrow("voice-screen-reader readScreen: refused");
    await expect(helper.request("readScreen")).rejects.toThrow("voice-screen-reader readScreen timed out");
    // A reply after the time is up is dropped.
    child.stdout.write(`${JSON.stringify({ id: 2, result: {} })}\n`);
    child.stderr.write("debug: a read failed\n");
    await tick();
    expect(logged).toEqual(["voice-screen-reader: debug: a read failed\n"]);
  });
});

describe("the page's commands and reports", () => {
  test("a command waits for the page to ask, or goes at once to a page asking", () => {
    const channel = pageChannel();
    const got: Command[] = [];
    channel.deliver({ kind: "done" });
    channel.ask((command) => got.push(command));
    expect(got).toEqual([{ kind: "done" }]);
    channel.ask((command) => got.push(command));
    channel.deliver({ kind: "select", line: 1, from: 0, to: 0 });
    expect(got).toEqual([{ kind: "done" }, { kind: "select", line: 1, from: 0, to: 0 }]);
    // Asked once, answered once.
    channel.deliver({ kind: "done" });
    expect(got).toHaveLength(2);
  });

  test("a command sent resolves with the page's next report, or fails if none comes in time", async () => {
    const channel = pageChannel({ page: 20 });
    const got: Command[] = [];
    channel.ask((command) => got.push(command));
    const placed = channel.send({ kind: "select", line: 2, from: 1, to: 1 });
    expect(got).toEqual([{ kind: "select", line: 2, from: 1, to: 1 }]);
    channel.report({ selected: "" });
    await expect(placed).resolves.toEqual({ selected: "" });
    await expect(channel.send({ kind: "select", line: 2, from: 1, to: 1 })).rejects.toThrow("the page did not answer");
  });

  test("a command the page answers leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const channel = pageChannel();
      channel.ask(() => undefined);
      const placed = channel.send({ kind: "select", line: 2, from: 1, to: 1 });
      expect(vi.getTimerCount()).toBe(1);
      channel.report({ selected: "" });
      await expect(placed).resolves.toEqual({ selected: "" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a new page gets none of the old page's commands, and its first report says it is ready", async () => {
    const channel = pageChannel();
    const old: Command[] = [];
    channel.ask((command) => old.push(command));
    channel.deliver({ kind: "done" });
    channel.deliver({ kind: "select", line: 3, from: 0, to: 0 });
    const ready = channel.open();
    const fresh: Command[] = [];
    channel.ask((command) => fresh.push(command));
    expect(fresh).toEqual([]);
    channel.report({ ready: true });
    await expect(ready).resolves.toEqual({ ready: true });
    // A page that failed left its request open: the new page's commands do not go to it.
    channel.ask(() => old.push({ kind: "done" }));
    const stale = channel.open();
    channel.deliver({ kind: "done" });
    expect(old).toEqual([{ kind: "done" }]);
    channel.report({ ready: true });
    await expect(stale).resolves.toEqual({ ready: true });
  });
});

describe("the code editor bundle's packages", () => {
  test("a module's package is its folder under node_modules, with / between folders on every system", () => {
    expect(packageOf("/app/node_modules/@codemirror/view/dist/index.js")).toEqual({ folder: "/app/node_modules/@codemirror/view", name: "@codemirror/view" });
    // Vite names a Windows module so, with / and the drive.
    expect(packageOf("C:/app/node_modules/@codemirror/view/dist/index.js")).toEqual({ folder: "C:/app/node_modules/@codemirror/view", name: "@codemirror/view" });
    expect(packageOf("C:/app/node_modules/style-mod/src/style-mod.js")).toEqual({ folder: "C:/app/node_modules/style-mod", name: "style-mod" });
    expect(packageOf("/app/node_modules/a/node_modules/w3c-keyname/index.js")).toEqual({ folder: "/app/node_modules/a/node_modules/w3c-keyname", name: "w3c-keyname" });
    expect(packageOf("/app/native/shared/browser-pages/codemirror-entry.mjs")).toBeNull();
  });

  test("the bundle opens with each package's version and licence", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-browser-pages-"));
    try {
      for (const [name, version] of [["@scope/one", "1.2.3"], ["two", "4.5.6"]] as const) {
        mkdirSync(join(root, "node_modules", name), { recursive: true });
        writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
        writeFileSync(join(root, "node_modules", name, "LICENSE"), `Licence of ${name}\n`);
      }
      const moduleIds = [`${root}/node_modules/two/index.js`, `${root}/node_modules/@scope/one/dist/a.js`, `${root}/node_modules/@scope/one/dist/b.js`, `${root}/entry.mjs`].map((id) => id.replaceAll("\\", "/"));
      const render = licences.renderChunk as unknown as (code: string, chunk: { moduleIds: string[] }) => string;
      expect(render("CODE", { moduleIds }).split("\n")).toEqual([
        "// Generated by apps/desktop/scripts/browser-pages.mts; do not edit by hand.",
        '// packages: {"@scope/one":"1.2.3","two":"4.5.6"}',
        "/*", "@scope/one:", "", "Licence of @scope/one", "", "two:", "", "Licence of two", "", "*/", "CODE",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** `run.mjs` itself, with stand-ins for the helpers and the browser: small programs that answer as
 * the real ones do, the browser loading the page from the driver's server and running its commands. */
describe("run.mjs", () => {
  const pages = join(__dirname, "../../native/shared/browser-pages");
  const helperScript = `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    import { basename, join } from "node:path";
    import { createInterface } from "node:readline";
    import { lines } from ${JSON.stringify(join(pages, "document.mjs"))};
    const name = basename(process.argv[1], ".mjs");
    const dir = process.env.FAKE_STATE;
    writeFileSync(join(dir, \`pid-helper-\${name}-\${process.pid}\`), "");
    const state = () => JSON.parse(readFileSync(join(dir, "caret.json"), "utf8"));
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      appendFileSync(join(dir, "requests.log"), \`\${name} \${method} \${JSON.stringify(params)}\\n\`);
      const { browser, page, size, line: at, from, to } = state();
      const text = lines(page, size);
      const result = method === "frontmostApp" ? { pid: 7 }
        : method === "readScreen" ? { bundleID: \`\${browser}.desktop\`, appName: browser, textBeforeCaret: \`\${text.slice(0, at).join("\\n")}\\n\${text[at].slice(0, from)}\`, selectedText: text[at].slice(from, to), textAfterCaret: \`\${text[at].slice(to)}\\n\${text.slice(at + 1).join("\\n")}\` }
        : method === "focusedFieldValue" ? { value: text.join("\\n") }
        : method === "caretAnchor" && (name === "voice-linux" || name === "voice-windows") ? { x: 5 + to * 8, y: 9 + at * 20, height: 16 }
        : null;
      process.stdout.write(\`\${JSON.stringify({ id, result })}\\n\`);
    });
  `;
  const browserScript = `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { lines } from ${JSON.stringify(join(pages, "document.mjs"))};
    const dir = process.env.FAKE_STATE;
    // Firefox is started with its profile, Chromium with its user data folder: which it was, how, and its launcher.
    const args = process.argv.slice(2);
    const browser = args.includes("-profile") ? "firefox" : "chromium";
    const profile = args.includes("-profile") ? args[args.indexOf("-profile") + 1] : null;
    writeFileSync(join(dir, \`pid-browser-\${process.pid}\`), JSON.stringify({ browser, args, launcher: process.env.GIO_LAUNCHED_DESKTOP_FILE ?? null,
      accessibility: [process.env.ACCESSIBILITY_ENABLED, process.env.GNOME_ACCESSIBILITY], userJs: profile && existsSync(join(profile, "user.js")) ? readFileSync(join(profile, "user.js"), "utf8") : null }));
    const url = new URL(process.argv.at(-1));
    const page = url.pathname.slice(1, -".html".length);
    const size = url.searchParams.get("size");
    // The driver serves the pages' files, and nothing else of its folder.
    for (const [file, status] of [[url.pathname, 200], ["/document.mjs", 200], ["/harness.mjs", 200], ["/run.mjs", 404], ["/driver.mjs", 404]]) {
      if ((await fetch(new URL(file, url))).status !== status) process.exit(3);
    }
    const post = (body) => fetch(new URL("/report", url), { method: "POST", body: JSON.stringify(body) });
    await post({ ready: true });
    for (;;) {
      const command = await (await fetch(new URL("/command", url))).json();
      if (command.kind === "done") break;
      writeFileSync(join(dir, "caret.json"), JSON.stringify({ browser, page, size, ...command }));
      const text = lines(page, size)[command.line];
      const at = (offset) => ({ x: offset * 8, y: command.line * 20, height: 16 });
      await post({ selected: page === "codemirror" && size === "short" ? text.slice(command.from, command.to) : "stray", caret: at(command.to), start: at(command.from), scale: 1, screen: { x: 0, y: 0, frameX: 0, frameY: 0 } });
    }
    setInterval(() => undefined, 1000);
  `;
  // Windows' PowerShell as run.mjs asks it, for the processes started with a profile (matched in each
  // process's command line, here the arguments the stand-in browsers recorded): the first activated,
  // as AppActivate would, or every one ended.
  const powershellScript = `
    import { readdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const dir = process.env.FAKE_STATE;
    const command = process.argv.at(-1);
    const profile = /-like '\\*([^*']+)\\*'/.exec(command)?.[1];
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const started = readdirSync(dir).filter((name) => /^pid-(browser|other)-/.test(name))
      .filter((name) => profile && JSON.parse(readFileSync(join(dir, name), "utf8")).args.some((arg) => arg.includes(profile)))
      .map((name) => Number(name.split("-").at(-1))).filter(alive);
    if (command.includes("AppActivate") && started.length) writeFileSync(join(dir, \`activated-\${started[0]}\`), "");
    if (command.includes("Stop-Process")) for (const pid of started) process.kill(pid);
  `;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  interface Started { browser: string; args: string[]; launcher: string | null; accessibility: (string | undefined)[]; userJs: string | null }

  /** Runs run.mjs with stand-in helpers and browsers, as on Linux, or as on Windows (`win32`). */
  async function runDriver(platform: "linux" | "win32" = "linux") {
    const root = mkdtempSync(join(tmpdir(), "voice-run-"));
    const [home, helpers, state, bin] = ["home", "helpers", "state", "bin"].map((name) => join(root, name)) as [string, string, string, string];
    for (const dir of [home, helpers, state, bin]) mkdirSync(dir);
    // Each program a shell script running its module with this Node, in place (exec), so its process is the one started.
    const program = (path: string, module: string, script: string) => {
      writeFileSync(module, script);
      writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(module)} "$@"\n`);
      chmodSync(path, 0o755);
    };
    const windows = platform === "win32";
    const names = windows ? ["voice-windows", "voice-screen-reader", "voice-field-reader"] : ["voice-linux", "voice-screen-reader", "voice-field-reader", "voice-hotkey"];
    for (const name of names) program(join(helpers, windows ? `${name}.exe` : name), join(root, `${name}.mjs`), helperScript);
    program(join(root, "browser"), join(root, "browser.mjs"), browserScript);
    program(join(bin, "powershell.exe"), join(root, "powershell.mjs"), powershellScript);
    // Another process with a profile of its own, which the run must leave running.
    const other = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)", "--", `--user-data-dir=${join(home, "voice-browser-pages-other")}`], { stdio: "ignore" });
    writeFileSync(join(state, `pid-other-${other.pid}`), JSON.stringify({ args: [`--user-data-dir=${join(home, "voice-browser-pages-other")}`] }));
    const launcher = join(root, "chromium.desktop");
    const child = spawn(process.execPath, [
      // On Windows, as Node there names it.
      ...(windows ? ["--import", `data:text/javascript,Object.defineProperty(process, "platform", { value: "win32" });`] : []),
      join(pages, "run.mjs"), "--helpers", helpers, "--browser", `firefox=${join(root, "browser")}`,
      "--browser", `chrome=${join(root, "browser")}`, ...(windows ? [] : ["--desktop-file", `chrome=${launcher}`])], {
      env: { ...process.env, HOME: home, FAKE_STATE: state, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    const pids = (kind: string) => readdirSync(state).filter((name) => name.startsWith(`pid-${kind}-`)).map((name) => Number(name.split("-").at(-1)));
    const started = readdirSync(state).filter((name) => name.startsWith("pid-browser-")).map((name) => JSON.parse(readFileSync(join(state, name), "utf8")) as Started);
    const helperNames = readdirSync(state).filter((name) => name.startsWith("pid-helper-")).map((name) => name.split("-").slice(2, -1).join("-"));
    const activated = readdirSync(state).filter((name) => name.startsWith("activated-")).map((name) => Number(name.split("-").at(-1)));
    return { root, home, launcher, output, status, started, browsers: pids("browser"), helpers: pids("helper"), helperNames, activated, other };
  }

  // The stand-ins are POSIX shell scripts; on Windows the driver starts the helpers' .exe programs,
  // which only the real helpers are, so there it runs against them (the browser-page runs).
  test.skipIf(process.platform === "win32")("serves the pages, reads them through the helpers, starts them afresh after a page that failed, cleans up after itself, and exits 1", async () => {
    const { root, home, launcher, output, status, started, browsers, helpers } = await runDriver();
    try {
      // The short code page read whole, right, in each browser; every other page's first caret placed wrong.
      for (const browser of ["firefox", "chrome"]) {
        expect(output.split("\n").filter((line) => line.startsWith(`PASS ${browser} codemirror `) && !line.includes(" long-"))).toHaveLength(1 + 5 * 3);
        for (const page of ["codemirror long", "compose short", "compose long"]) expect(output).toContain(`FAIL ${browser} ${page}-document: ${browser} ${page.split(" ")[0]} `);
      }
      expect(output).toContain("38 of 44 reads as expected");
      expect(status).toBe(1);
      // Each browser started as the app finds it: Firefox with a profile of its own that asks nothing at its
      // first start, Chromium with its own user data, accessibility on, and the launcher named for it.
      const firefox = started.filter(({ browser }) => browser === "firefox");
      const chromium = started.filter(({ browser }) => browser === "chromium");
      expect([firefox.length, chromium.length]).toEqual([4, 4]);
      for (const each of started) expect(each.accessibility).toEqual(["1", "1"]);
      for (const each of firefox) {
        expect(each.args.slice(0, 3)).toEqual(["-no-remote", "-new-instance", "-profile"]);
        expect(each.args[3]?.startsWith(join(home, "voice-browser-pages-"))).toBe(true);
        expect(each.userJs).toContain('user_pref("termsofuse.bypassNotification", true);');
        expect(each.launcher).toBeNull();
      }
      for (const each of chromium) {
        expect(each.args.filter((arg) => arg.startsWith("--user-data-dir=")).map((arg) => arg.startsWith(`--user-data-dir=${join(home, "voice-browser-pages-")}`))).toEqual([true]);
        expect(each.args).toContain("--force-renderer-accessibility");
        expect(each.args).toContain("--disable-renderer-backgrounding");
        expect(each.launcher).toBe(launcher);
      }
      // Eight browsers, the helpers started afresh after each failed page (the last ones can be
      // ended before they say they started), and every one ended; every browser's profile deleted.
      expect(browsers).toHaveLength(8);
      expect(helpers.length).toBeGreaterThanOrEqual(8 * 3);
      expect([...browsers, ...helpers].filter(alive)).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test.skipIf(process.platform === "win32")("on Windows, starts the Windows helpers, activates each browser by its profile, and ends every process started with it, and no other", async () => {
    const { root, home, output, status, started, browsers, helpers, helperNames, activated, other } = await runDriver("win32");
    try {
      expect(output).toContain("PASS firefox codemirror short-document identity");
      expect(output).toContain("PASS chrome codemirror short-document identity");
      expect(status).toBe(1);
      expect(new Set(helperNames)).toEqual(new Set(["voice-windows", "voice-screen-reader", "voice-field-reader"]));
      expect(started).toHaveLength(8);
      // Each browser's window activated, by the processes started with its own profile.
      expect(new Set(activated)).toEqual(new Set(browsers));
      // Every browser and helper ended, and every profile deleted; the other process is still running.
      expect([...browsers, ...helpers].filter(alive)).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
      expect(alive(other.pid ?? 0)).toBe(true);
    } finally {
      other.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
