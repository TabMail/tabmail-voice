// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Renders the built windows with sample states, offscreen, and saves each as a PNG, to check the
// UI without running the app (which would start the helpers and read the keychain):
// `npm run build:renderer && npx electron scripts/preview/index.mts [output folder]`.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import type { SettingsState } from "../../src/shared/ipc.js";

const root = join(import.meta.dirname, "../..");
const output = process.argv[2] ?? join(tmpdir(), "tabmail-voice-preview");

const overlay = { mode: "dictation", level: 0.5, isHearing: true, hasVoice: true, isRetrying: false, language: "en", tip: null, hotkey: "rightOption", tools: [], connectors: [], emailAppIcon: null, opensUpward: false, bubblesFitUnder: true, chat: null, recentBubbles: [], runningConnectors: [], chatPlacement: null };
/** `config.overlayCanvasSize`: a script run by Electron cannot import the app's TypeScript. */
/** Every app, as `connectors`. */
const allConnectors = ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"];
const overlayCanvasSize = { width: 440, height: 258 };
/** The overlay window with the chat window at its tallest (`chatWindowFrame`), and where the pill is
 * in it, over it or under it. */
const chatWindowSize = { width: 412, height: 420 };
const over = { below: false, maxHeight: 320, bubblesUnder: true, pillX: 206 };
const under = { below: true, maxHeight: 320, bubblesUnder: true, pillX: 206 };
/** A conversation: an answer laid out as Thunderbird's chat lays one out, and a follow-up under way. */
const conversation = {
  turns: [
    { id: 0, request: "What's on Friday?", tool: "answer", reply: "Friday has two things:\n\n1. **Launch review** at 10:00\n2. Team lunch at 12:30, at the usual place\n\nWant me to add a reminder?" },
  ],
  pendingRequest: null,
  closesAt: null,
  touched: true,
  activity: null,
  confirmation: null,
  confirmationExpiresAt: null,
};
const settings = {
  availableHotkeys: ["rightOption", "function"],
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
  vscodeFix: "notNeeded",
  openAtLogin: false,
  debugAllowed: false,
  debugMode: false,
  version: "1.2.3",
  update: { kind: "idle" },
  dictionary: [],
  learnsWords: true,
  smartDictation: false,
  canLearnWords: true,
  excludedApps: [],
  excludedSites: [],
  canExcludeApps: true,
  builtInExcludedApps: [{ bundleIdentifier: "com.1password.1password", name: "1Password" }],
  userName: "Alex Example",
  suggestedName: "Alex Example",
  enabledTools: ["edit", "compose", "thunderbird", "answer"], connectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"], enabledConnectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"],
} satisfies SettingsState;
const welcome = { step: "consent", index: 0, categoryIndex: 0, isFirstStep: true, isLastStep: false, canAdvance: false, hasConsented: false, canLearnWords: true, readsScreen: true, microphoneGranted: false, accessibilityTrusted: false, vscodeFix: "notNeeded", userName: null, suggestedName: "Alex Example", enabledTools: ["edit", "compose", "thunderbird", "answer"], connectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"], enabledConnectors: ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"] };

/** The paste history: a short entry, a long one clipped to its lines, and an older one. */
const history = {
  entries: [
    { id: 3, text: "Sounds good, see you at ten.", at: Date.now() - 20_000 },
    { id: 2, text: "Thanks for sending the draft over. I read through it this morning and left a few notes in the margins; the second section needs the numbers from last quarter, and the summary could be shorter. Happy to go over it together on Friday if that helps.", at: Date.now() - 4 * 60_000 },
    { id: 1, text: "Can we move the review to Thursday?", at: Date.now() - 3 * 3_600_000 },
  ],
};
/** `config.pasteHistoryWindowWidth` by `config.pasteHistoryMaxHeight`. */
const historyWindowSize = { width: 380, height: 440 };

/** `config.settingsWindowSize`: a script run by Electron cannot import the app's TypeScript. */
const settingsWindowSize = { width: 700, height: 500 };
/** `config.welcomeWindowSize`. */
const welcomeWindowSize = { width: 560, height: 660 };

/** A shot of `page` with `state`; `whole` names what must show whole in it (the welcome window's
 * buttons, below everything else; a question's buttons in a chat long enough to scroll): inside the
 * window and inside every box above it in the page that clips. */
const shots: { name: string; page: string; size: { width: number; height: number }; state: unknown; transparent?: boolean; dark?: boolean; forcedColors?: boolean; section?: string; whole?: string }[] = [
  ...[
    ["overlay-listening", { phase: { kind: "listening" } }],
    ["overlay-swirl", { phase: { kind: "listening" }, isHearing: false }],
    ["overlay-tip-switch", { phase: { kind: "listening" }, tip: "agentAndHistory" }],
    ["overlay-tip-double-tap", { phase: { kind: "listening" }, tip: "doubleTap", language: null }],
    ["overlay-tip-hands-free", { phase: { kind: "listening" }, tip: "handsFree" }],
    ["overlay-tip-whats-new", { phase: { kind: "listening" }, tip: "longDictations" }],
    ["overlay-tip-hands-free-up", { phase: { kind: "listening" }, tip: "handsFree", opensUpward: true, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-transcribing", { phase: { kind: "transcribing" } }],
    ["overlay-transcribing-retry", { phase: { kind: "transcribing" }, isRetrying: true }],
    ["overlay-agent-listening", { phase: { kind: "listening" }, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-agent-running", { phase: { kind: "running", tool: "compose" }, mode: "agent", tools: ["compose", "thunderbird"] }],
    ["overlay-agent-apps", { phase: { kind: "listening" }, mode: "agent", tools: ["compose", "thunderbird", "answer"], connectors: allConnectors, tip: "agentAndHistory" }],
    ["overlay-agent-apps-up", { phase: { kind: "listening" }, mode: "agent", tools: ["compose", "thunderbird", "answer"], connectors: allConnectors, bubblesFitUnder: false, opensUpward: true, tip: "handsFree" }],
    ["overlay-agent-apps-running", { phase: { kind: "running", tool: "answer" }, mode: "agent", tools: ["compose", "thunderbird", "answer"], connectors: allConnectors }],
    ["overlay-agent-history", { phase: { kind: "listening" }, mode: "agent", tools: ["compose", "thunderbird", "answer"], connectors: allConnectors, recentBubbles: ["web", "answer", "notes"] }],
    ["overlay-retrying", { phase: { kind: "retrying", message: "Server error, retrying…" } }],
    ["overlay-failed", { phase: { kind: "failed", message: "Didn't catch that. Try again." } }],
    ["overlay-copied", { phase: { kind: "copied", message: "Switched apps: copied to clipboard and history" } }],
    ["overlay-failed-long", { phase: { kind: "failed", message: "Mail and calendar requests need Thunderbird with TabMail. Choose it in Settings, or make it your default email app." } }],
  ].map(([name, change]) => ({ name: name as string, page: "overlay/index.html", size: overlayCanvasSize, state: { ...overlay, ...(change as object) }, transparent: true })),
  ...(
    [
    // Resting between follow-ups, the last request's bubbles kept, the latest to run first.
    ["overlay-chat-answer", { phase: { kind: "idle" }, mode: "agent", tools: ["answer"], connectors: allConnectors, recentBubbles: ["web", "answer"], chat: conversation, chatPlacement: over }],
    ["overlay-chat-below", { phase: { kind: "idle" }, mode: "agent", tools: ["answer"], connectors: allConnectors, recentBubbles: ["web", "answer"], chat: conversation, chatPlacement: under }],
    // The backend searching the web for a follow-up: the web's bubble circles, the chat says so.
    ["overlay-chat-searching", { phase: { kind: "running", tool: "answer" }, mode: "agent", tools: ["answer"], connectors: allConnectors, recentBubbles: ["web", "answer"], runningConnectors: ["web"], chat: { ...conversation, pendingRequest: "Look up the usual place", activity: "Searching the web: usual lunch place" }, chatPlacement: over }],
    // A tool's question in the chat window, a third of its 30 seconds gone.
    ["overlay-chat-confirmation", { phase: { kind: "running", tool: "answer" }, mode: "agent", tools: ["answer"], connectors: allConnectors, recentBubbles: ["calendar", "answer"], chat: { turns: [], pendingRequest: "Add the launch review on Friday at ten", closesAt: null, touched: false, activity: null, confirmation: "Add “Launch review” to your calendar on Friday at 10:00?", confirmationExpiresAt: Date.now() + 20_000 }, chatPlacement: over }],
    // A chat long enough to scroll: the question keeps its height and its buttons show.
    ["overlay-chat-confirmation-long", { phase: { kind: "running", tool: "answer" }, mode: "agent", tools: ["answer"], connectors: allConnectors, recentBubbles: ["calendar", "answer"], chat: { turns: [{ id: 0, request: "Can you add this to my calendar?", tool: "answer", reply: "Happy to add it. Which item on the screen do you mean: the date and time, the title, and any other details? What is on screen does not give me the specifics I need yet." }, { id: 1, request: "The launch review, tomorrow at ten.", tool: "answer", reply: "Here is the entry:\n\n- Title: Launch review\n- When: tomorrow at 10:00\n- No location given\n\nShall I go ahead?" }], pendingRequest: "Yes.", closesAt: null, touched: false, activity: null, confirmation: "Add “Launch review” to your calendar tomorrow at 10:00?", confirmationExpiresAt: Date.now() + 20_000 }, chatPlacement: over, whole: ".chat-confirm" }],
    ] as [string, Record<string, unknown> & { whole?: string }][]
  ).map(([name, { whole, ...change }]) => ({ name, page: "overlay/index.html", size: chatWindowSize, state: { ...overlay, ...change }, transparent: true, ...(whole === undefined ? {} : { whole }) })),
  { name: "history", page: "history/index.html", size: historyWindowSize, state: history },
  { name: "history-dark", page: "history/index.html", size: historyWindowSize, dark: true, state: history },
  { name: "history-empty", page: "history/index.html", size: historyWindowSize, state: { entries: [] } },
  { name: "settings", page: "settings/index.html", size: settingsWindowSize, state: settings },
  { name: "settings-signed-in", page: "settings/index.html", size: settingsWindowSize, state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  { name: "settings-dark", page: "settings/index.html", size: settingsWindowSize, dark: true, state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  // Agent mode's tool and app switches, every app on.
  { name: "settings-agent-mode", page: "settings/index.html", size: settingsWindowSize, section: "Agent mode", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true } },
  // No name for agent mode: the field is empty with the account's name as placeholder, and the section is marked.
  { name: "settings-agent-mode-no-name", page: "settings/index.html", size: settingsWindowSize, section: "Agent mode", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true, userName: null } },
  // VS Code's settings hide the caret: Permissions offers to fix them.
  // The dictionary: typed words and a learned one.
  { name: "settings-dictionary", page: "settings/index.html", size: settingsWindowSize, section: "Dictionary", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true, dictionary: [{ word: "Xyvora", learned: false }, { word: "Kaelthorne Drake", learned: false }, { word: "TabMail", learned: true }] } },
  { name: "settings-privacy", page: "settings/index.html", size: settingsWindowSize, section: "Privacy", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true, excludedApps: [{ bundleIdentifier: "org.example.bank", name: "Example Bank" }, { bundleIdentifier: "org.example.notes", name: "Example Notes" }], excludedSites: ["example.com", "bank.example.org"] } },
  { name: "settings-permissions-vscode", page: "settings/index.html", size: settingsWindowSize, section: "Permissions", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true, vscodeFix: "needed" } },
  { name: "settings-general", page: "settings/index.html", size: settingsWindowSize, section: "General", state: { ...settings, email: "user@example.com", hotkey: "rightOption", accessibilityTrusted: true, debugAllowed: true } },
  // As under a Windows contrast theme, on a section with switches, others needing attention.
  { name: "settings-forced-colors", page: "settings/index.html", size: settingsWindowSize, forcedColors: true, section: "Dictation", state: settings },
  { name: "welcome-features", page: "welcome/index.html", size: welcomeWindowSize, whole: "footer", state: { ...welcome, step: "screenReading", index: 4, categoryIndex: 3, isFirstStep: false, isLastStep: true, canAdvance: true, hasConsented: true, accessibilityTrusted: true } },
  { name: "welcome-consent", page: "welcome/index.html", size: welcomeWindowSize, whole: "footer", state: welcome },
  { name: "welcome-name", page: "welcome/index.html", size: welcomeWindowSize, whole: "footer", state: { ...welcome, step: "name", index: 1, categoryIndex: 1, isFirstStep: false, canAdvance: true, hasConsented: true } },
  { name: "welcome-accessibility", page: "welcome/index.html", size: welcomeWindowSize, whole: "footer", state: { ...welcome, step: "accessibility", index: 3, categoryIndex: 2, isFirstStep: false, canAdvance: true, hasConsented: true } },
  { name: "welcome-accessibility-vscode", page: "welcome/index.html", size: welcomeWindowSize, whole: "footer", state: { ...welcome, step: "accessibility", index: 3, categoryIndex: 2, isFirstStep: false, canAdvance: true, hasConsented: true, vscodeFix: "needed" } },
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
  const whole = shot.whole === undefined || ((await window.webContents.executeJavaScript(`(() => { const element = document.querySelector(${JSON.stringify(shot.whole)}); const box = element?.getBoundingClientRect(); if (box === undefined || box.top < 0 || box.bottom > innerHeight) return false; for (let above = element.parentElement; above !== null && above !== document.body; above = above.parentElement) { const clip = above.getBoundingClientRect(); if (getComputedStyle(above).overflowY !== "visible" && (box.top < clip.top || box.bottom > clip.bottom)) return false; } return true; })()`)) as boolean);
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
