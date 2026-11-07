// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What `run.mjs` does with the helpers, the browsers and the pages, given them: the helpers'
// requests, the page's commands and reports, and every read of every page in every browser. `run.mjs`
// starts the helper processes, the browsers and the page's server; the tests give stand-ins.
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { checkAnchors, checkField, checkIdentity, checkScreen, verdict } from "./checks.mjs";
import { cases, lines } from "./document.mjs";

/** How long, in milliseconds: a helper may take to answer; a page may take to load and to place a
 * caret; and the reads wait for the browser's accessibility events after a caret moves, then
 * between tries of a read the browser has not caught up with. How many tries a read gets, and how
 * many a new window gets to be named as in front. */
export const timing = { request: 10_000, page: 30_000, settle: 300, retry: 300, tries: 5, front: 20 };
/** The longest field `focusedFieldValue` reads, as the app asks it. */
export const fieldMaxLength = 20_000;
export const pages = ["codemirror", "compose"];
const policy = { excludedAppIDs: [], excludedHosts: [] };

/** A request its helper did not answer in time. */
export class RequestTimeoutError extends Error {}

/** A helper process, asked one request at a time: a JSON line each way, the reply by its request's
 * id. `log` gets the helper's stderr lines, which say why a read failed (the pages hold synthetic
 * text only). */
export function rpc(name, child, { log = (line) => process.stderr.write(line), request = timing.request } = {}) {
  createInterface({ input: child.stderr }).on("line", (line) => log(`${name}: ${line}\n`));
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  let id = 0;
  return {
    child,
    request(method, params = {}) {
      const next = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(next); reject(new RequestTimeoutError(`${name} ${method} timed out`)); }, request);
        pending.set(next, (reply) => {
          clearTimeout(timer);
          if (reply.error) reject(new Error(`${name} ${method}: ${reply.error.message}`));
          else resolve(reply.result);
        });
        child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
      });
    },
  };
}

/** The driver's side of a page: the page asks for its next command (`ask`, with how to answer it)
 * and reports (`report`); the driver gives it commands (`deliver`, or `send` to wait for its report)
 * and opens a new page (`open`, which resolves with its first report, that it is ready). */
export function pageChannel({ page = timing.page } = {}) {
  let command = null;
  let waiting = null;
  let report = null;
  const channel = {
    ask(respond) {
      waiting = respond;
      if (command) { waiting(command); command = null; waiting = null; }
    },
    report(body) { report?.(body); },
    /** Gives the page its next command, now if it is asking, or when it next asks. */
    deliver(next) {
      if (waiting) { waiting(next); waiting = null; } else command = next;
    },
    /** Sends the page a command; resolves with its next report. */
    send(next) {
      const reported = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the page did not answer")), page);
        report = (body) => { clearTimeout(timer); report = null; resolve(body); };
      });
      channel.deliver(next);
      return reported;
    },
    /** Nothing from a page before is kept: one that failed can leave its request for a command
     * open, and a command given to it would be lost to the new page. */
    open() {
      command = null;
      waiting = null;
      return new Promise((resolve) => { report = resolve; });
    },
  };
  return channel;
}

/** Reads every page, short and long, in every browser named, on `platform` ("linux" or "win32"):
 * each case's caret put in the page, then read three ways, as the app reads it, and judged by
 * `checks.mjs`. `startHelpers()` gives the helpers (`main`, `reader`, `fieldReader` and, on Linux,
 * `shell`) and `stop()`; they are started again after a page that failed, which can leave one still
 * busy with a read that timed out. `launch(browser, url)` opens a page's window (`activate()`,
 * `close()`), `url(page, size)` names it. Writes one line a read, and one for a page whose reads
 * could not go on; resolves with the reads and the run's exit status: 1 if any read fails (or one
 * recorded as failing passes). */
export async function readPages({ platform, browsers, startHelpers, launch, channel, url, write, wait = delay, times = timing }) {
  const windows = platform === "win32";
  let helpers = startHelpers();
  let reads = 0;

  /** A screen read as the app asks one: numbered, and asked to stop (`readScreenStop`) when it does
   * not answer in time, so the reads after it do not wait behind it, unless it is held in a call to
   * the browser, which no stop interrupts. */
  function readScreen() {
    reads += 1;
    const read = reads;
    const { reader } = helpers;
    return reader.request("readScreen", { ...policy, read }).catch(async (error) => {
      if (error instanceof RequestTimeoutError) await reader.request("readScreenStop", { read }).catch(() => null);
      throw error;
    });
  }

  /** A read, tried again while `check` finds it wrong and the browser may not have caught up with
   * the caret yet; a request that fails is no reply. */
  async function settled(request, check) {
    let reply = null;
    for (let tries = 0; tries < times.tries; ++tries) {
      await wait(tries === 0 ? times.settle : times.retry);
      reply = await request().catch(() => null);
      if (check(reply).length === 0) break;
    }
    return reply;
  }

  /** The caret context, once the browser is in front and its reads have caught up with the page. */
  function readCaret(browser, documentLines, testCase) {
    return settled(readScreen, (read) => {
      if (read?.bundleID !== "" && typeof read?.appName === "string" && checkIdentity(browser.name, read).length) throw new Error(`${browser.name} is not in front (${read.appName})`);
      return checkScreen(documentLines, testCase, read);
    });
  }

  /** The caret anchor as the app asks it: the main helper's, then on Linux the Shell's, also where the
   * main helper's request fails, as the app goes on to the Shell's then. */
  async function caretAnchor(front) {
    const anchor = await helpers.main.request("caretAnchor", windows ? { window: front?.window } : {}).catch(() => null);
    return anchor || !helpers.shell ? anchor : helpers.shell.request("caretAnchor");
  }

  /** Puts a caret in the new window until the screen reader reads it: a browser starts its
   * accessibility only when asked, after its window took the focus, and until then the window has
   * no focused element to read. Gives that first read, for the app it names. An app the helpers
   * could not name (on Linux, an empty bundle ID) is taken as the browser, nothing else being in
   * front; another app named is not, nor a reply naming none (a hidden screen). Windows names an
   * app by its program (`appName`), with no bundle ID. */
  async function bringToFront(browser, window, testCase) {
    let last = "nothing";
    for (let tries = 0; tries < times.front; ++tries) {
      if (windows) window.activate();
      await channel.send({ kind: "select", line: testCase.line, from: testCase.from, to: testCase.to });
      await wait(times.retry);
      const read = await readScreen().catch((error) => { last = error.message; return null; });
      if (typeof read?.appName === "string" && (read.bundleID === "" || checkIdentity(browser.name, read).length === 0)) return read;
      if (read) last = `${JSON.stringify(read.appName)} (${JSON.stringify(read.bundleID)})`;
    }
    throw new Error(`${browser.name} never came to the front; the last read was ${last}`);
  }

  const results = [];
  function record(key, wrong) {
    const outcome = verdict(platform, key, wrong);
    results.push({ key, outcome });
    write(`${outcome.toUpperCase()} ${key}${wrong.length ? `: ${wrong.join("; ")}` : ""}\n`);
  }

  try {
    for (const browser of browsers) {
      for (const page of pages) {
        for (const size of ["short", "long"]) {
          const documentLines = lines(page, size);
          const loaded = channel.open();
          const window = launch(browser, url(page, size));
          try {
            // A timer cleared once the page loads, so none is left to keep the run going after its last page.
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`${page} did not load in ${browser.name}`)), times.page);
              loaded.then(() => { clearTimeout(timer); resolve(); });
            });
            const first = await bringToFront(browser, window, cases(page).find((each) => each.size === size));
            record(`${browser.name} ${page} ${size}-document identity`, checkIdentity(browser.name, first));
            const anchors = [];
            for (const testCase of cases(page).filter((each) => each.size === size)) {
              const key = `${browser.name} ${page} ${testCase.name}`;
              const placed = await channel.send({ kind: "select", line: testCase.line, from: testCase.from, to: testCase.to });
              const want = documentLines[testCase.line].slice(testCase.from, testCase.to);
              if (placed.selected !== want) throw new Error(`${key}: the page selected ${JSON.stringify(placed.selected)}, not ${JSON.stringify(want)}`);
              record(`${key} readScreen`, checkScreen(documentLines, testCase, await readCaret(browser, documentLines, testCase)));
              const front = await helpers.main.request("frontmostApp");
              const target = windows ? { window: front?.window } : { pid: front?.pid };
              const field = await settled(() => helpers.fieldReader.request("focusedFieldValue", { ...policy, ...target, maxLength: fieldMaxLength }), (reply) => checkField(documentLines, testCase, reply));
              record(`${key} focusedFieldValue`, checkField(documentLines, testCase, field));
              // Judged as the page's reads are, so an anchor the browser has not moved yet is asked again.
              const entry = (anchor) => ({ name: testCase.name, report: placed, anchor });
              const anchor = await settled(() => caretAnchor(front), (rect) => checkAnchors([...anchors, entry(rect)], { onScreen: windows }).filter(({ name }) => name === testCase.name));
              anchors.push(entry(anchor));
            }
            // Wayland tells a page nothing of its place on the screen, so there only the carets'
            // places relative to each other are checked.
            const wrong = checkAnchors(anchors, { onScreen: windows });
            for (const { name } of anchors) record(`${browser.name} ${page} ${name} caretAnchor`, wrong.filter((each) => each.name === name).map(({ why }) => why));
            channel.deliver({ kind: "done" });
          } catch (error) {
            // A page whose reads could not go on is one failure, and the other pages are still read.
            record(`${browser.name} ${page} ${size}-document`, [error.message]);
            helpers.stop();
            helpers = startHelpers();
          } finally {
            await window.close();
          }
        }
      }
    }
  } finally {
    helpers.stop();
  }
  const failed = results.filter(({ outcome }) => outcome === "fail" || outcome === "fixed");
  write(`${results.length - failed.length} of ${results.length} reads as expected\n`);
  return { results, status: failed.length ? 1 : 0 };
}
