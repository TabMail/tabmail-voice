// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Renders the built windows with sample states, offscreen, and saves each as a PNG, to check the
// UI without running the app (which would start the helpers and read the keychain):
// `npm run build:renderer && npx electron scripts/preview/preview.mts [output folder]`.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";

const root = join(import.meta.dirname, "../..");
const output = process.argv[2] ?? join(tmpdir(), "tabmail-voice-preview");

const overlay = { mode: "dictation", level: 0.5, isHearing: true, language: "en", tip: null, hotkey: "rightOption", tools: [], emailAppIcon: null, opensUpward: false, chat: null, chatOpensUpward: false };
/** `config.overlayCanvasSize`: a script run by Electron cannot import the app's TypeScript. */
const overlayCanvasSize = { width: 440, height: 258 };
const settings = {
  email: null,
  hotkey: "function",
  readsScreen: true,
  emailClient: null,
  systemEmailApp: { bundleIdentifier: "com.apple.mail", name: "Mail" },
  installedEmailApps: [{ bundleIdentifier: "org.mozilla.thunderbird", name: "Thunderbird" }],
  hasTabMail: true,
  defaultEmailAppIsSupported: false,
  microphoneGranted: true,
  accessibilityTrusted: false,
  openAtLogin: false,
  debugAllowed: false,
  debugMode: false,
  enabledTools: ["edit", "compose", "thunderbird", "answer"], connectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "shortcuts"], enabledConnectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "shortcuts"],
};
const welcome = { step: "consent", index: 0, categoryIndex: 0, isFirstStep: true, isLastStep: false, canAdvance: false, hasConsented: false, readsScreen: true, microphoneGranted: false, accessibilityTrusted: false, enabledTools: ["edit", "compose", "thunderbird", "answer"], connectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "shortcuts"], enabledConnectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "shortcuts"] };

/** `config.settingsWindowSize`: a script run by Electron cannot import the app's TypeScript. */
const settingsWindowSize = { width: 700, height: 500 };
/** `config.welcomeWindowSize`. */
const welcomeWindowSize = { width: 560, height: 660 };

/** A shot of `page` with `state`; `whole` names what must show whole in it (the welcome window's
 * buttons, below everything else). */
const shots: { name: string; page: string; size: { width: number; height: number }; state: unknown; transparent?: boolean; dark?: boolean; forcedColors?: boolean; section?: string; whole?: string }[] = [
  ...[
    ["overlay-listening", { phase: { kind: "listening" } }],
    ["overlay-swirl", { phase: { kind: "listening" }, isHearing: false }],
    ["overlay-tip-switch", { phase: { kind: "listening" }, tip: "switchMode" }],
    ["overlay-tip-double-tap", { phase: { kind: "listening" }, tip: "doubleTap", language: null }],
    ["overlay-tip-hands-free", { phase: { kind: "listening" }, tip: "handsFree" }],
    ["overlay-tip-hands-free-up", { phase: { kind: "listening" }, tip: "handsFree", opensUpward: true, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-transcribing", { phase: { kind: "transcribing" } }],
    ["overlay-agent-listening", { phase: { kind: "listening" }, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-agent-running", { phase: { kind: "running", tool: "compose" }, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-failed", { phase: { kind: "failed", message: "Didn't catch that. Try again." } }],
    ["overlay-failed-long", { phase: { kind: "failed", message: "Mail and calendar requests need Thunderbird with TabMail. Choose it in Settings, or make it your default email app." } }],
  ].map(([name, change]) => ({ name: name as string, page: "overlay.html", size: overlayCanvasSize, state: { ...overlay, ...(change as object) }, transparent: true })),
  { name: "settings", page: "settings.html", size: settingsWindowSize, state: settings },
  { name: "settings-signed-in", page: "settings.html", size: settingsWindowSize, state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  { name: "settings-dark", page: "settings.html", size: settingsWindowSize, dark: true, state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  // Agent mode's tool and app switches, every app on.
  { name: "settings-agent-mode", page: "settings.html", size: settingsWindowSize, section: "Agent mode", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  // As under a Windows contrast theme, on a section with switches, others needing attention.
  { name: "settings-forced-colors", page: "settings.html", size: settingsWindowSize, forcedColors: true, section: "Dictation", state: settings },
  { name: "welcome-features", page: "welcome.html", size: welcomeWindowSize, whole: "footer", state: { ...welcome, step: "screenReading", index: 3, categoryIndex: 2, isFirstStep: false, isLastStep: true, canAdvance: true, hasConsented: true, accessibilityTrusted: true } },
  { name: "welcome-consent", page: "welcome.html", size: welcomeWindowSize, whole: "footer", state: welcome },
  { name: "welcome-accessibility", page: "welcome.html", size: welcomeWindowSize, whole: "footer", state: { ...welcome, step: "accessibility", index: 2, categoryIndex: 1, isFirstStep: false, canAdvance: true, hasConsented: true } },
];

async function capture(shot: (typeof shots)[number]): Promise<void> {
  nativeTheme.themeSource = shot.dark ? "dark" : "light";
  const window = new BrowserWindow({
    ...shot.size,
    show: false,
    transparent: shot.transparent ?? false,
    frame: false,
    webPreferences: {
      sandbox: false,
      contextIsolation: false,
      preload: join(import.meta.dirname, "preload.cjs"),
      additionalArguments: [`--preview-state=${encodeURIComponent(JSON.stringify(shot.state))}`],
    },
  });
  // A page that logs an error (React's, for a state it can't render) is no preview of it.
  let errors = 0;
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors += 1;
    process.stdout.write(`${shot.name}: console ${details.level}: ${details.message}\n`);
  });
  await window.loadFile(join(root, "dist/renderer", shot.page));
  if (shot.forcedColors) {
    window.webContents.debugger.attach();
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  }
  // The page renders after it loads: wait for the section's button, and fail rather than shoot the
  // first section under another's name.
  if (shot.section) {
    const shown = (await window.webContents.executeJavaScript(
      `new Promise((resolve) => { const started = Date.now(); const click = () => { const button = [...document.querySelectorAll("button.nav")].find((button) => button.textContent === ${JSON.stringify(shot.section)}); if (button) { button.click(); resolve(true); } else if (Date.now() - started > 5000) resolve(false); else setTimeout(click, 50); }; click(); })`,
    )) as boolean;
    if (!shown) throw new Error(`the page has no ${shot.section} section`);
  }
  // Past the appear animations.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const rendered = (await window.webContents.executeJavaScript(`(document.getElementById("root")?.childElementCount ?? 0) > 0`)) as boolean;
  const whole = shot.whole === undefined || ((await window.webContents.executeJavaScript(`(() => { const box = document.querySelector(${JSON.stringify(shot.whole)})?.getBoundingClientRect(); return box !== undefined && box.top >= 0 && box.bottom <= innerHeight; })()`)) as boolean);
  if (errors > 0 || !rendered || !whole) throw new Error(`the page ${errors > 0 ? "logged errors" : !rendered ? "rendered nothing" : `cut off ${shot.whole}`}`);
  const image = await window.webContents.capturePage();
  writeFileSync(join(output, `${shot.name}.png`), image.toPNG());
  window.close();
}

app.dock?.hide();
void app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true });
  for (const shot of shots) {
    await capture(shot).catch((error: unknown) => {
      process.stdout.write(`${shot.name}: ${String(error)}\n`);
      process.exitCode = 1;
    });
  }
  process.stdout.write(`${process.exitCode === 1 ? "Some previews failed; saved the others" : `Saved ${shots.length} previews`} to ${output}\n`);
  app.quit();
});
