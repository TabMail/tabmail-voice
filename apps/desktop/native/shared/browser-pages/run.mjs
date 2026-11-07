// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Reads real browser editors with the Linux or Windows helpers: the code editor page (CodeMirror,
// as Overleaf) and the mail page (a contenteditable, as Gmail), each short and long, in each
// browser named. Every caret of `document.mjs`'s cases is put in the page, then read three ways,
// as the app reads it: the screen read's caret context (`readScreen`, voice-screen-reader), the
// focused field (`focusedFieldValue`, voice-field-reader) and the caret anchor (`caretAnchor`,
// the main helper; on Linux, the Shell's caret where it has none). `checks.mjs` judges each read.
//
// Run in a signed-in desktop session (GNOME with accessibility on, or Windows), with nothing else
// in front, from any folder:
//   node run.mjs --helpers <folder of the built helpers> --browser firefox=<path> --browser chrome=<path>
// A browser is named `firefox`, `chrome` or `edge`, with the path of its program. It starts with a
// new profile of its own, deleted after, and opens only this script's own server on 127.0.0.1.
// On Linux, `--desktop-file <name>=<file>` names the browser's launcher, which the desktop names to
// a program it starts (GIO_LAUNCHED_DESKTOP_FILE): the helpers know an app by it, and a browser
// whose program is not its launcher's (a snap) is otherwise an app they cannot name, and its
// identity read fails.
// Prints one line a read, and one for a page whose reads could not go on; exits 1 if any read fails
// (or one recorded as failing passes). `driver.mjs` makes the reads; this starts the helpers, the
// browsers and the pages' server for it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserNames } from "./checks.mjs";
import { pageChannel, readPages, rpc } from "./driver.mjs";

const files = new Set(["codemirror.html", "codemirror-page.mjs", "codemirror.js", "compose.html", "compose.mjs", "document.mjs", "harness.mjs"]);
const here = import.meta.dirname;
const windows = process.platform === "win32";
const exe = windows ? ".exe" : "";

const options = { helpers: "", browsers: [], desktopFiles: {} };
for (let index = 2; index < process.argv.length; index += 2) {
  const [flag, value] = [process.argv[index], process.argv[index + 1] ?? ""];
  if (flag === "--helpers") options.helpers = value;
  else if (flag === "--browser" && value.includes("=")) {
    const name = value.slice(0, value.indexOf("="));
    if (!(name in browserNames)) throw new Error(`unknown browser ${name}`);
    options.browsers.push({ name, path: value.slice(value.indexOf("=") + 1) });
  } else if (flag === "--desktop-file" && !windows && value.includes("=")) {
    options.desktopFiles[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
  } else throw new Error(`unknown option ${flag}`);
}
if (!options.helpers || options.browsers.length === 0) throw new Error("usage: node run.mjs --helpers <folder> --browser <name>=<path> …");

/** The helper processes, as the app starts them. */
function startHelpers() {
  const start = (name) => rpc(name, spawn(join(options.helpers, `${name}${exe}`), [], { stdio: ["pipe", "pipe", "pipe"] }));
  const helpers = {
    main: start(windows ? "voice-windows" : "voice-linux"),
    reader: start("voice-screen-reader"),
    fieldReader: start("voice-field-reader"),
    shell: windows ? null : start("voice-hotkey"),
    stop() {
      for (const each of [helpers.main, helpers.reader, helpers.fieldReader, helpers.shell]) each?.child.kill();
    },
  };
  return helpers;
}

/** The page's server: its files, and the driver's commands to the page and the page's reports. */
const channel = pageChannel();
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/command") {
    channel.ask((next) => response.end(JSON.stringify(next)));
    return;
  }
  if (path === "/report" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { response.end(); channel.report(JSON.parse(body)); });
    return;
  }
  const file = basename(path);
  if (!files.has(file)) { response.statusCode = 404; response.end(); return; }
  response.setHeader("content-type", file.endsWith(".html") ? "text/html" : "text/javascript");
  response.end(readFileSync(join(here, file)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function launch(browser, url) {
  const profile = mkdtempSync(join(homedir(), "voice-browser-pages-"));
  let args;
  if (browser.name === "firefox") {
    // No first-run pages, so the test page is the window's only tab, and no terms-of-use or data
    // notice over it (Firefox 157 and later show one, holding the focus, in a new profile).
    writeFileSync(join(profile, "user.js"), [
      'user_pref("termsofuse.bypassNotification", true);',
      'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
      'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);',
    ].join("\n"));
    args = ["-no-remote", "-new-instance", "-profile", profile, url];
  } else {
    // Chromium took the Windows test machine's window as covered and drew nothing (no frames, so the
    // page never placed a caret): its occlusion check and background throttling are off.
    args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--force-renderer-accessibility",
      "--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--new-window", url];
  }
  const child = spawn(browser.path, args, {
    detached: !windows,
    stdio: "ignore",
    env: {
      ...process.env,
      ACCESSIBILITY_ENABLED: "1",
      GNOME_ACCESSIBILITY: "1",
      ...(options.desktopFiles[browser.name] ? { GIO_LAUNCHED_DESKTOP_FILE: options.desktopFiles[browser.name] } : {}),
    },
  });
  return {
    /** Windows lets no program started in the background take the foreground: the browser's window
     * is activated, as a click into it would. By its process, not its title: the taskbar keeps a
     * window of its own titled as each tab, which a title would activate instead. */
    activate() {
      spawnSync("powershell.exe", ["-NoProfile", "-Command",
        `$ids = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { $_.ProcessId }; ` +
        `$shown = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
        `if ($shown) { $null = (New-Object -ComObject WScript.Shell).AppActivate($shown.Id) }`], { stdio: "ignore" });
    },
    async close() {
      // On Windows a browser's first process can hand the window to another and end, so every
      // process started with this profile is ended, by its command line.
      if (windows) {
        spawnSync("powershell.exe", ["-NoProfile", "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore" });
      } else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } }
      await delay(1000);
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
      catch (error) { process.stderr.write(`the profile ${profile} was left: ${error.code}\n`); }
    },
  };
}

try {
  const { status } = await readPages({
    platform: process.platform,
    browsers: options.browsers,
    startHelpers,
    launch,
    channel,
    url: (page, size) => `http://127.0.0.1:${port}/${page}.html?size=${size}`,
    write: (line) => process.stdout.write(line),
  });
  process.exitCode = status;
} finally {
  server.close();
}
