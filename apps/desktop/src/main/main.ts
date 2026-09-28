// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { app, ipcMain, screen, session, shell } from "electron";
import { AccountModel, AuthClient, DebugAccess } from "../core/account.js";
import { EmailClient } from "../core/agent/emailClient.js";
import { ThunderbirdRelay } from "../core/agent/thunderbirdRelay.js";
import { CompletionsClient, TranscriptionClient } from "../core/backend.js";
import * as config from "../core/config.js";
import { DictationController } from "../core/dictationController.js";
import { GlobeKeyAction } from "../core/globeKeyAction.js";
import { type DictationHotkey, isHotkeyAction } from "../core/hotkey.js";
import { liveTransport } from "../core/http.js";
import { configureLog, errorName, log } from "../core/log.js";
import type { MenuState } from "../core/menuModel.js";
import { PermissionsModel } from "../core/permissions.js";
import { ScreenContextProbe } from "../core/screenContext.js";
import { AppSettings } from "../core/settings.js";
import { TipBook } from "../core/tips.js";
import { WelcomeWizard } from "../core/welcomeWizard.js";
import {
  type AudioCommand,
  channels,
  type Command,
  type CommandResult,
  isAudioReport,
  isCommand,
  isWindowName,
  type OverlayState,
  type SettingsState,
  type WelcomeState,
  type WindowName,
  type WindowStates,
} from "../shared/ipc.js";
import { SessionAudioCapture } from "./audioCapture.js";
import { FileStore } from "./fileStore.js";
import { HelperClient } from "./helperClient.js";
import { KeychainSessionStore } from "./keychainSessionStore.js";
import { LogFile } from "./logFile.js";
import { type EmailAppInfo, MacSystem } from "./macos.js";
import { OverlayWindowController } from "./overlayWindow.js";
import { macPermissions } from "./permissions.js";
import { nodeProfileFiles } from "./profileFiles.js";
import { TrayMenu } from "./tray.js";
import { Windows } from "./windows.js";

/** Debug builds are the unpackaged app (`npm start`); a packaged build is a release. */
const isDebugBuild = !app.isPackaged;
/** Shown for a failure without a message of its own. */
const genericError = "Something went wrong. Try again.";
/** The pages a window may open in the browser. */
const openableURLs: readonly string[] = [config.termsURL, config.privacyURL];

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(launch, (error: unknown) => {
    log.error(`main: launch failed: ${errorName(error)}`);
  });
} else {
  app.quit();
}

/** Owns the long-lived objects and wires them together (`AppDelegate` in the Swift app). */
function launch(): void {
  const logPath = join(app.getPath("logs"), "TabMail Voice.log");
  const logFile = new LogFile(logPath, config.logFileMaxBytes);
  configureLog({
    isDebugBuild,
    sinks: {
      file: (level, text) => logFile.append(level, text),
      error: (text) => process.stderr.write(`${text}\n`),
    },
  });
  // A menu-bar app: no Dock icon (packaged builds say so in Info.plist as well).
  app.dock?.hide();

  const lastRecordingPath = join(tmpdir(), config.debugLastRecordingFileName);
  const thunderbirdDirectory = join(homedir(), config.thunderbirdDataDirectory);
  const hasTabMail = (): boolean => EmailClient.hasTabMail(thunderbirdDirectory, nodeProfileFiles);

  const store = new FileStore(join(app.getPath("userData"), "settings.json"));
  const settings = new AppSettings(store, hasTabMail);
  const permissions = new PermissionsModel(macPermissions);
  const account = new AccountModel(new AuthClient(liveTransport), new KeychainSessionStore());

  const helpers = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "dist"), "helpers");
  const helperEnv = isDebugBuild ? { TABMAIL_VOICE_DEBUG: "1" } : {};
  const hotkeyHelper = new HelperClient({ name: "voice-hotkey", executable: join(helpers, "voice-hotkey"), env: helperEnv });
  const macHelper = new HelperClient({ name: "voice-macos", executable: join(helpers, "voice-macos"), env: helperEnv });
  const mac = new MacSystem(macHelper);

  let wizard: WelcomeWizard | null = null;
  let stopObservingWizard: (() => void) | null = null;
  let emailApps: { systemDefault: EmailAppInfo | null; installed: EmailAppInfo[] } = { systemDefault: null, installed: [] };
  let emailAppIcon: { path: string | null; dataURL: string | null } = { path: null, dataURL: null };

  const windows = new Windows(stateOf);

  function sendAudio(command: AudioCommand): void {
    const contents = windows.audio().webContents;
    if (contents.isLoading()) contents.once("did-finish-load", () => contents.send(channels.audioCommand, command));
    else contents.send(channels.audioCommand, command);
  }
  // On macOS the helper runs the microphone as the Swift app does: Chromium's `getUserMedia` opens
  // the device afresh for each dictation, about a second slower to the first audio.
  const capture = new SessionAudioCapture(process.platform === "darwin" ? mac.microphone((report) => capture.receive(report)) : sendAudio);
  // A helper that exits takes a running microphone with it.
  if (process.platform === "darwin") macHelper.onExit = () => capture.lost();

  const probe = new ScreenContextProbe(
    () => permissions.accessibilityTrusted,
    () => mac.readScreen(),
    () => windows.push("contextDebug"),
  );

  const controller = new DictationController({
    permissions,
    settings: () => settings.dictation(account.email),
    account,
    tips: new TipBook(store),
    paste: (text, signal) => mac.paste(text, signal),
    thunderbird: new ThunderbirdRelay(mac.thunderbird),
    capture,
    frontmostApp: () => mac.frontmostApp(),
    keyboardLanguage: () => mac.keyboardLanguage(),
    systemEmailApp: () => mac.systemEmailApp(),
    makeTranscriptionClient: (baseURL) => new TranscriptionClient(baseURL, app.getVersion(), liveTransport),
    makeCompletionsClient: (baseURL) => new CompletionsClient(baseURL, app.getVersion(), liveTransport),
    keepRecording: isDebugBuild
      ? (wav) => {
          writeFile(lastRecordingPath, wav).catch((error: unknown) => {
            log.error(`main: couldn't keep the last recording: ${errorName(error)}`);
          });
        }
      : undefined,
  });
  controller.captureContext = () => probe.capture();

  const overlay = new OverlayWindowController(windows.overlay(), async () => {
    const pid = await mac.frontmostApp();
    return pid === null ? null : mac.caretAnchor(pid);
  });

  const tray = new TrayMenu(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), menuState, {
    showWelcome,
    showSettings,
    requestMicrophone: () => void permissions.requestMicrophone(),
    requestAccessibility: () => permissions.requestAccessibility(),
    toggleDictation: () => controller.toggle(),
    quit: () => app.quit(),
    debug: isDebugBuild
      ? {
          hasLastRecording: () => existsSync(lastRecordingPath),
          playLastRecording: () => void shell.openPath(lastRecordingPath),
          showLastScreenContext: () => windows.showContextDebug(),
          showLogFile: () => shell.showItemInFolder(logPath),
        }
      : null,
  });

  function stateOf<Name extends WindowName>(name: Name): WindowStates[Name] {
    const states: { [Key in WindowName]: () => WindowStates[Key] } = { overlay: overlayState, settings: settingsState, welcome: welcomeState, contextDebug: () => ({ context: probe.lastContext }) };
    return states[name]();
  }

  function overlayState(): OverlayState {
    return {
      phase: controller.phase,
      mode: controller.mode,
      level: controller.level,
      isHearing: controller.isHearing,
      language: controller.language,
      tip: controller.tip,
      opensUpward: overlay.opensUpward,
      hotkey: controller.settings.hotkey,
      tools: controller.tools,
      emailAppIcon: emailAppIcon.path === controller.emailAppPath ? emailAppIcon.dataURL : null,
    };
  }

  function settingsState(): SettingsState {
    const systemDefault = emailApps.systemDefault;
    return {
      email: account.email,
      hotkey: settings.hotkey,
      readsScreen: settings.readsScreen,
      emailClient: settings.emailClient,
      systemEmailApp: systemDefault && { bundleIdentifier: systemDefault.bundleIdentifier, name: systemDefault.name },
      installedEmailApps: emailApps.installed.map(({ bundleIdentifier, name }) => ({ bundleIdentifier, name })),
      hasTabMail: hasTabMail(),
      defaultEmailAppIsSupported: EmailClient.resolve(null, systemDefault?.bundleIdentifier ?? null, true) !== null,
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      debugAllowed: DebugAccess.allows(account.email),
      debugMode: settings.debugMode,
    };
  }

  function welcomeState(): WelcomeState {
    const current = wizard ?? new WelcomeWizard(settings);
    return {
      step: current.step,
      index: current.index,
      categoryIndex: current.categoryIndex,
      isFirstStep: current.isFirstStep,
      isLastStep: current.isLastStep,
      canAdvance: current.canAdvance,
      hasConsented: settings.hasConsented,
      readsScreen: settings.readsScreen,
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
    };
  }

  function menuState(): MenuState {
    return {
      hasConsented: settings.hasConsented,
      isSignedIn: account.isSignedIn,
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
      hotkey: settings.hotkey,
      debugMode: settings.isDebugMode(account.email),
      phase: controller.phase,
    };
  }

  /** Opens the welcome wizard at its first step; brings the open one forward instead. */
  function showWelcome(): void {
    if (!windows.isOpen("welcome")) {
      stopObservingWizard?.();
      const fresh = new WelcomeWizard(settings);
      fresh.onFinish = () => windows.close("welcome");
      stopObservingWizard = fresh.observe(() => windows.push("welcome"));
      wizard = fresh;
    }
    windows.showWelcome();
  }

  /** Opens Settings, with the email apps read afresh as it opens. */
  function showSettings(): void {
    permissions.refresh();
    windows.showSettings();
    mac.emailApps(config.thunderbirdBundleIdentifiers).then(
      (apps) => {
        emailApps = apps;
        windows.push("settings");
      },
      (error: unknown) => {
        log.error(`main: couldn't list the email apps: ${errorName(error)}`);
      },
    );
  }

  /** The Thunderbird bubble shows the email app's icon: read once per app. */
  function updateEmailAppIcon(): void {
    const path = controller.emailAppPath;
    if (path === null || path === emailAppIcon.path) return;
    emailAppIcon = { path, dataURL: null };
    // Sharp on the densest display the overlay may show on.
    const pixels = Math.ceil(config.agentBubbleAppIconSize * Math.max(...screen.getAllDisplays().map((display) => display.scaleFactor)));
    mac.appIcon(path, pixels).then(
      (dataURL) => {
        if (emailAppIcon.path !== path) return;
        emailAppIcon = { path, dataURL };
        windows.push("overlay");
      },
      (error: unknown) => {
        log.debug(`main: no icon for the email app: ${errorName(error)}`);
      },
    );
  }

  function pushSettingsWindows(): void {
    windows.push("settings");
    windows.push("welcome");
    tray.update();
  }

  // MARK: Hotkey

  function configureHotkey(hotkey: DictationHotkey): void {
    hotkeyHelper
      .request<{ installed: boolean }>("configure", { hotkey, tapMaxDuration: config.minimumHoldDuration / 1000, doubleTapWindow: config.doubleTapWindow / 1000 })
      .then(({ installed }) => log.debug(`main: hotkey ${hotkey} ${installed ? "installed" : "not installed (no Accessibility grant yet)"}`))
      .catch((error: unknown) => {
        log.error(`main: couldn't configure the hotkey: ${errorName(error)}`);
      });
  }

  function startActivator(): void {
    mac.startActivator().catch((error: unknown) => {
      log.error(`main: couldn't start the accessibility activator: ${errorName(error)}`);
    });
  }

  hotkeyHelper.onStart = () => configureHotkey(settings.hotkey);
  hotkeyHelper.on("action", (message) => {
    if (isHotkeyAction(message.action)) controller.handle(message.action);
  });
  // A restarted helper has no microphone prepared. This is also the launch's prewarm, on every
  // platform: `start()` runs `onStart` even where `voice-macos` can't spawn, preparing the audio
  // window there (give that its own prewarm when a native helper replaces it).
  macHelper.onStart = () => {
    startActivator();
    controller.prewarm();
  };

  // The hotkey follows Settings, and so does the Globe key's own action: off while fn is the
  // hotkey, the user's choice back at another key and when the app quits (ADR-DESK-031).
  const globeKey = new GlobeKeyAction(mac.globeKey, store);
  settings.onHotkeyChange = (hotkey) => {
    configureHotkey(hotkey);
    void globeKey.hotkeyIs(hotkey);
  };

  controller.onPhaseChange = (phase) => {
    overlay.update(phase);
    tray.update();
    switch (phase.kind) {
      case "arming":
      case "listening":
        return;
      default:
        // Finished, failed or cancelled without the hotkey: hands-free listening is over too.
        hotkeyHelper.request("dictationEnded").catch((error: unknown) => {
          log.error(`main: dictationEnded failed: ${errorName(error)}`);
        });
    }
  };
  controller.observe(() => {
    updateEmailAppIcon();
    windows.push("overlay");
  });
  overlay.onPlace = () => windows.push("overlay");
  settings.observe(pushSettingsWindows);
  account.observe(pushSettingsWindows);
  permissions.observe(pushSettingsWindows);

  // The hotkey's event tap can't be created until Accessibility is granted: configure again once
  // the grant lands.
  permissions.onAccessibilityGranted = () => {
    configureHotkey(settings.hotkey);
    startActivator();
  };
  permissions.onMicrophoneGranted = () => controller.prewarm();

  // MARK: IPC

  // Only the hidden audio window may use the microphone, and nothing may use anything else.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    callback(permission === "media" && windows.isAudioWindow(contents) && mediaTypes.every((type) => type === "audio"));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === "media" && contents !== null && windows.isAudioWindow(contents));

  ipcMain.handle(channels.getState, (_event, name: unknown) => (isWindowName(name) ? stateOf(name) : null));
  ipcMain.handle(channels.command, async (_event, command: unknown): Promise<CommandResult> => {
    if (!isCommand(command)) return { error: genericError };
    try {
      await run(command);
      return { error: null };
    } catch (error) {
      log.error(`main: ${command.type} failed: ${errorName(error)}`);
      return { error: error instanceof Error && error.message !== "" ? error.message : genericError };
    }
  });
  ipcMain.on(channels.audioReport, (event, report: unknown) => {
    if (windows.isAudioWindow(event.sender) && isAudioReport(report)) capture.receive(report);
  });

  async function run(command: Command): Promise<void> {
    switch (command.type) {
      case "sendCode":
        return account.sendCode(command.email);
      case "verify":
        return account.verify(command.email, command.code);
      case "signOut":
        account.signOut();
        return;
      case "setHotkey":
        settings.hotkey = command.hotkey;
        return;
      case "setReadsScreen":
        settings.readsScreen = command.value;
        return;
      case "setEmailClient":
        if (command.bundleIdentifier === null || config.thunderbirdBundleIdentifiers.includes(command.bundleIdentifier)) settings.emailClient = command.bundleIdentifier;
        return;
      case "setOpenAtLogin":
        app.setLoginItemSettings({ openAtLogin: command.value });
        pushSettingsWindows();
        return;
      case "setDebugMode":
        if (DebugAccess.allows(account.email)) settings.debugMode = command.value;
        return;
      case "setConsent":
        settings.hasConsented = command.value;
        return;
      case "requestMicrophone":
        return permissions.requestMicrophone();
      case "requestAccessibility":
        return permissions.requestAccessibility();
      case "welcomeNext":
        return wizard?.next();
      case "welcomeBack":
        return wizard?.back();
      case "welcomeGoTo":
        return wizard?.goTo(command.index);
      case "openURL":
        if (openableURLs.includes(command.url)) await shell.openExternal(command.url);
        return;
    }
  }

  // MARK: Launch

  app.on("did-become-active", () => permissions.refresh());
  app.on("second-instance", showSettings);

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void globeKey
      .restore()
      .then(() => {
        hotkeyHelper.stop();
        macHelper.stop();
        return logFile.flush();
      })
      .finally(() => app.quit());
  });

  hotkeyHelper.start();
  macHelper.start();
  void globeKey.hotkeyIs(settings.hotkey);
  permissions.startPollingAccessibility();

  // The welcome wizard asks for consent and the permissions; it opens until finished.
  if (!settings.hasFinishedWelcome) showWelcome();
}
