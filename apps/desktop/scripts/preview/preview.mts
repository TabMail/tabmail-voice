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

const overlay = { mode: "dictation", level: 0.5, isHearing: true, language: "en", tip: null, hotkey: "rightOption", tools: [], emailAppIcon: null };
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
};
const welcome = { step: "consent", index: 0, categoryIndex: 0, isFirstStep: true, isLastStep: false, canAdvance: false, hasConsented: false, readsScreen: true, microphoneGranted: false, accessibilityTrusted: false };

/** `config.settingsWindowSize`: a script run by Electron cannot import the app's TypeScript. */
const settingsWindowSize = { width: 700, height: 500 };

const shots: { name: string; page: string; size: { width: number; height: number }; state: unknown; transparent?: boolean; dark?: boolean; forcedColors?: boolean; section?: string }[] = [
  ...[
    ["overlay-listening", { phase: { kind: "listening" } }],
    ["overlay-swirl", { phase: { kind: "listening" }, isHearing: false }],
    ["overlay-tip-switch", { phase: { kind: "listening" }, tip: "switchMode" }],
    ["overlay-tip-double-tap", { phase: { kind: "listening" }, tip: "doubleTap", language: null }],
    ["overlay-transcribing", { phase: { kind: "transcribing" } }],
    ["overlay-agent-listening", { phase: { kind: "listening" }, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-agent-running", { phase: { kind: "running", tool: "compose" }, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-failed", { phase: { kind: "failed", message: "Didn't catch that. Try again." } }],
    ["overlay-failed-long", { phase: { kind: "failed", message: "Mail and calendar requests need Thunderbird with TabMail. Choose it in Settings, or make it your default email app." } }],
  ].map(([name, change]) => ({ name: name as string, page: "overlay.html", size: { width: 440, height: 210 }, state: { ...overlay, ...(change as object) }, transparent: true })),
  { name: "settings", page: "settings.html", size: settingsWindowSize, state: settings },
  { name: "settings-signed-in", page: "settings.html", size: settingsWindowSize, state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  { name: "settings-dark", page: "settings.html", size: settingsWindowSize, dark: true, state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  // As under a Windows contrast theme, on a section with switches.
  { name: "settings-forced-colors", page: "settings.html", size: settingsWindowSize, forcedColors: true, section: "Dictation", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  { name: "welcome-consent", page: "welcome.html", size: { width: 560, height: 500 }, state: welcome },
  { name: "welcome-accessibility", page: "welcome.html", size: { width: 560, height: 500 }, state: { ...welcome, step: "accessibility", index: 2, categoryIndex: 1, isFirstStep: false, canAdvance: true, hasConsented: true } },
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
  window.webContents.on("console-message", (details) => process.stdout.write(`${shot.name}: console ${details.level}: ${details.message}\n`));
  await window.loadFile(join(root, "dist/renderer", shot.page));
  if (shot.forcedColors) {
    window.webContents.debugger.attach();
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
  }
  if (shot.section) await window.webContents.executeJavaScript(`[...document.querySelectorAll("button.nav")].find((button) => button.textContent === ${JSON.stringify(shot.section)})?.click()`);
  // Past the appear animations.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
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
  process.stdout.write(`Saved ${shots.length} previews to ${output}\n`);
  app.quit();
});
