// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { app, autoUpdater as squirrel, clipboard, dialog, ipcMain, screen, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { AccountModel, AuthClient, DebugAccess } from "../core/account.js";
import { opensLink } from "../core/agent/agentChat.js";
import { calendarTools } from "../core/agent/calendarTools.js";
import { contactsTools } from "../core/agent/contactsTools.js";
import { filesTools } from "../core/agent/filesTools.js";
import { connectors } from "../core/agent/connectors.js";
import { EmailClient } from "../core/agent/emailClient.js";
import { type EmailOpener, emailTools, NoEmailAppFailure } from "../core/agent/emailTools.js";
import { messagesTools } from "../core/agent/messagesTools.js";
import { notesTools } from "../core/agent/notesTools.js";
import { liveWebFetch, webTools } from "../core/agent/webTools.js";
import { ThunderbirdRelay } from "../core/agent/thunderbirdRelay.js";
import { CompletionsClient, TranscriptionClient } from "../core/backend.js";
import * as config from "../core/config.js";
import { CorrectionWatch } from "../core/correctionWatch.js";
import { DictationController } from "../core/dictationController.js";
import { GlobeKeyAction } from "../core/globeKeyAction.js";
import { type DictationHotkey, isHotkeyAction } from "../core/hotkey.js";
import { liveTransport } from "../core/http.js";
import { configureLog, errorName, log } from "../core/log.js";
import type { MenuState } from "../core/menuModel.js";
import { historyWindowOrigin, type Point, type Rect } from "../core/overlayGeometry.js";
import { PasteHistory } from "../core/pasteHistory.js";
import { PermissionsModel } from "../core/permissions.js";
import { ScreenContextProbe } from "../core/screenContext.js";
import { AppSettings, suggestedUserName } from "../core/settings.js";
import { TipBook } from "../core/tips.js";
import { vscodeHidesCaret, vscodeSettingsPath, withClassicInput } from "../core/vscodeSettings.js";
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
  type VSCodeFix,
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
import { osascript } from "./osascript.js";
import { nodeProfileFiles } from "./profileFiles.js";
import { TrayMenu } from "./tray.js";
import { Updater } from "./updater.js";
import { Windows } from "./windows.js";

/** Debug builds are the unpackaged app (`npm start`); a packaged build is a release. */
const isDebugBuild = !app.isPackaged;
/** The apps the Answer tool can reach here: the Mac's, through `voice-macos` (ADR-DESK-024). */
const availableConnectors = process.platform === "darwin" ? [...connectors] : [];
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
  const vscodeSettingsFile = join(app.getPath("appData"), ...vscodeSettingsPath);
  /** Whether the welcome wizard or Settings changed VS Code's settings, to say so. */
  let fixedVSCode = false;
  /** The name the welcome wizard offers and Settings shows where none is set, once read
   * (`readSuggestedName`). */
  let suggestedName = "";

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

  // `email_compose`'s draft (ADR-DESK-027), opened with the app macOS opens `mailto:` links with,
  // which the result names.
  const emailOpener: EmailOpener = {
    open: async (url) => {
      const { systemDefault } = await mac.emailApps([]);
      if (!systemDefault) throw new NoEmailAppFailure();
      await shell.openExternal(url);
      return systemDefault.name;
    },
  };

  const probe = new ScreenContextProbe(
    () => permissions.accessibilityTrusted,
    () => mac.readScreen(),
    () => windows.push("contextDebug"),
  );

  const history = new PasteHistory();
  const controller = new DictationController({
    permissions,
    settings: () => settings.dictation(account.email),
    account,
    tips: new TipBook(store),
    captureTarget: (session) => mac.captureTarget(session),
    paste: (text, session, signal) => mac.paste(text, session, signal),
    copy: (text) => clipboard.writeText(text),
    history,
    thunderbird: new ThunderbirdRelay(mac.thunderbird),
    capture,
    frontmostApp: () => mac.frontmostApp(),
    keyboardLanguage: () => mac.keyboardLanguage(),
    systemEmailApp: () => mac.systemEmailApp(),
    makeTranscriptionClient: (baseURL) => new TranscriptionClient(baseURL, app.getVersion(), liveTransport),
    warmUp: (baseURL, accessToken) => new TranscriptionClient(baseURL, app.getVersion(), liveTransport).warmUp(accessToken),
    makeCompletionsClient: (baseURL) => new CompletionsClient(baseURL, app.getVersion(), liveTransport),
    // The tools that run on this computer, for the Answer prompt's model (ADR-DESK-023): the Mac's
    // apps (ADR-DESK-024), Notes and Messages through AppleScript (ADR-DESK-028), the web
    // (ADR-DESK-030), none elsewhere.
    loopTools:
      process.platform === "darwin"
        ? [...calendarTools(mac.eventStore), ...contactsTools(mac.contactStore), ...filesTools(mac.fileStore, homedir()), ...emailTools(emailOpener), ...notesTools(osascript), ...messagesTools(osascript), ...webTools(liveWebFetch, { open: (url) => shell.openExternal(url) })]
        : [],
    // The user's corrections are learned where the helper reads the field: macOS (ADR-DESK-038).
    corrections: process.platform === "darwin" ? new CorrectionWatch((pid) => mac.focusedFieldValue(pid), (words) => settings.learnWords(words)) : undefined,
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

  // Packaged builds keep themselves up to date from cdn.tabmail.ai (ADR-DESK-041).
  const updater = isDebugBuild ? null : makeUpdater();

  const tray = new TrayMenu(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), menuState, {
    showWelcome,
    showSettings,
    requestMicrophone: () => void permissions.requestMicrophone(),
    requestAccessibility: () => permissions.requestAccessibility(),
    toggleDictation: () => controller.toggle(),
    quit: () => app.quit(),
    checkForUpdates: () => updater?.checkNow(),
    restartToUpdate: () => updater?.restart(),
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
    const states: { [Key in WindowName]: () => WindowStates[Key] } = {
      overlay: overlayState,
      settings: settingsState,
      welcome: welcomeState,
      contextDebug: () => ({ context: probe.lastContext }),
      history: () => ({ entries: [...history.entries] }),
    };
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
      bubblesFitUnder: overlay.bubblesFitUnder,
      hotkey: controller.settings.hotkey,
      tools: controller.tools,
      connectors: controller.connectors,
      recentBubbles: controller.recentBubbles,
      runningConnectors: controller.runningConnectors,
      emailAppIcon: emailAppIcon.path === controller.emailAppPath ? emailAppIcon.dataURL : null,
      chat: controller.chat,
      chatPlacement: overlay.chatPlacement,
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
      enabledTools: settings.enabledTools,
      connectors: availableConnectors,
      enabledConnectors: settings.enabledConnectors,
      userName: settings.userName,
      suggestedName,
      dictionary: settings.dictionary,
      learnsWords: settings.learnsWords,
      canLearnWords: process.platform === "darwin",
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
      vscodeFix: vscodeFix(),
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      debugAllowed: DebugAccess.allows(account.email),
      debugMode: settings.debugMode,
    };
  }

  function welcomeState(): WelcomeState {
    const current = wizard ?? new WelcomeWizard(settings, () => suggestedName);
    return {
      step: current.step,
      index: current.index,
      categoryIndex: current.categoryIndex,
      isFirstStep: current.isFirstStep,
      isLastStep: current.isLastStep,
      canAdvance: current.canAdvance,
      hasConsented: settings.hasConsented,
      readsScreen: settings.readsScreen,
      enabledTools: settings.enabledTools,
      connectors: availableConnectors,
      enabledConnectors: settings.enabledConnectors,
      userName: settings.userName,
      suggestedName,
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
      vscodeFix: vscodeFix(),
    };
  }

  /** Only the macOS helper finds the caret yet; it is where VS Code's settings were measured. */
  function vscodeFix(): VSCodeFix {
    if (process.platform !== "darwin") return "notNeeded";
    if (vscodeHidesCaret(nodeProfileFiles.readText(vscodeSettingsFile))) return "needed";
    return fixedVSCode ? "done" : "notNeeded";
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
      update: updater?.state ?? null,
    };
  }

  function makeUpdater(): Updater {
    // Its own log goes to the console; ours says what failed.
    autoUpdater.logger = null;
    return new Updater({
      source: autoUpdater,
      installer: squirrel,
      currentVersion: app.getVersion(),
      ask: async (version) => {
        app.focus({ steal: true });
        const { response } = await dialog.showMessageBox({
          type: "info",
          message: `TabMail Voice ${version} is ready.`,
          detail: "It installs when TabMail Voice quits. Restart now to update?",
          buttons: ["Restart Now", "Later"],
          // Later is both: Return, typed as the question appears, does nothing; Escape picks Later.
          defaultId: 1,
          cancelId: 1,
        });
        return response === 0;
      },
      tell: (message, detail) => {
        app.focus({ steal: true });
        void dialog.showMessageBox({ type: "info", message, detail, buttons: ["OK"] });
      },
      // A failure or a copied note showing is at rest: the next hold replaces it.
      isBusy: () => !["idle", "failed", "copied"].includes(controller.phase.kind) || controller.chat !== null,
      onChange: () => tray.update(),
    });
  }

  /** Opens the welcome wizard at its first step; brings the open one forward instead. */
  function showWelcome(): void {
    if (!windows.isOpen("welcome")) {
      stopObservingWizard?.();
      const fresh = new WelcomeWizard(settings, () => suggestedName);
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

  /** Where the paste history opened: by the mouse pointer then, on its display. */
  let historyPlace: { pointer: Point; workArea: Rect } | null = null;

  /** The paste history (ADR-DESK-043), by the mouse pointer, at its tallest until its list measures
   * itself (`historyHeight`). */
  function showHistory(): void {
    const pointer = screen.getCursorScreenPoint();
    historyPlace = { pointer, workArea: screen.getDisplayNearestPoint(pointer).workArea };
    windows.showHistory(historyBounds(config.pasteHistoryMaxHeight), () => windows.close("history"));
  }

  function historyBounds(height: number): Rect {
    const size = { width: config.pasteHistoryWindowWidth, height: Math.round(Math.min(height, config.pasteHistoryMaxHeight)) };
    const origin = historyPlace ? historyWindowOrigin(historyPlace.pointer, size, historyPlace.workArea) : { x: 0, y: 0 };
    return { x: Math.round(origin.x), y: Math.round(origin.y), ...size };
  }

  /** Closes the paste history, and on macOS gives the app the user was in back its focus, unless
   * another of this app's windows is open, or the chat is: hiding the app would hide the chat too,
   * with nothing to show it again while the next holds talk to it. */
  function closeHistory(): void {
    windows.close("history");
    const othersOpen = (["settings", "welcome", "contextDebug"] as const).some((name) => windows.isOpen(name)) || controller.chat !== null;
    if (process.platform === "darwin" && !othersOpen) app.hide();
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

  /** The computer account's full name (macOS's, from `voice-macos`), else its short name
   * (`suggestedUserName`). */
  function readSuggestedName(): void {
    const fullName = process.platform === "darwin" ? mac.fullUserName() : Promise.resolve("");
    void fullName
      .catch((error: unknown) => {
        log.error(`main: no full user name: ${errorName(error)}`);
        return "";
      })
      .then((name) => {
        suggestedName = suggestedUserName(name, userInfo().username);
        pushSettingsWindows();
      });
  }

  function pushSettingsWindows(): void {
    windows.push("settings");
    windows.push("welcome");
    tray.update();
  }

  // MARK: Hotkey

  // `voice-hotkey` handles each request in its own task, so two state changes sent together could be
  // applied in either order (the chat window's closing before its opening, leaving Escape kept from
  // the app in front). Each waits until the one before is answered, that is applied, so the helper
  // ends in the state sent last.
  let hotkeyStateSent: Promise<unknown> = Promise.resolve();
  function sendHotkeyState<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const sent = hotkeyStateSent.then(() => hotkeyHelper.request<T>(method, params));
    hotkeyStateSent = sent.catch(() => undefined);
    return sent;
  }

  function configureHotkey(hotkey: DictationHotkey): void {
    sendHotkeyState<{ installed: boolean }>("configure", { hotkey, tapMaxDuration: config.minimumHoldDuration / 1000, doubleTapWindow: config.doubleTapWindow / 1000 })
      .then(({ installed }) => log.debug(`main: hotkey ${hotkey} ${installed ? "installed" : "not installed (no Accessibility grant yet)"}`))
      .catch((error: unknown) => {
        log.error(`main: couldn't configure the hotkey: ${errorName(error)}`);
      });
  }

  /** Escape closes the chat window while it is open, kept from the app in front. */
  function setChatOpen(isOpen: boolean): void {
    sendHotkeyState("setChatOpen", { isOpen }).catch((error: unknown) => {
      log.error(`main: setChatOpen failed: ${errorName(error)}`);
    });
  }

  function startActivator(): void {
    mac.startActivator().catch((error: unknown) => {
      log.error(`main: couldn't start the accessibility activator: ${errorName(error)}`);
    });
  }

  // A restarted helper knows nothing of the chat window either.
  hotkeyHelper.onStart = () => {
    configureHotkey(settings.hotkey);
    setChatOpen(controller.chat !== null);
  };
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

  // Nothing listens hands-free: the hotkey helper stops keeping Space and Escape from the app in front.
  const endHandsFree = () => {
    hotkeyHelper.request("dictationEnded").catch((error: unknown) => {
      log.error(`main: dictationEnded failed: ${errorName(error)}`);
    });
  };
  controller.onPhaseChange = (phase) => {
    overlay.update(phase, controller.chat !== null);
    tray.update();
    updater?.appIsFree();
    switch (phase.kind) {
      case "arming":
      case "listening":
        return;
      default:
        // Finished, failed or cancelled without the hotkey: hands-free listening is over too.
        endHandsFree();
    }
  };
  controller.onChatChange = (isOpen) => {
    setChatOpen(isOpen);
    overlay.update(controller.phase, isOpen);
    updater?.appIsFree();
  };
  controller.onNothingListening = endHandsFree;
  controller.onShowHistory = showHistory;
  history.observe(() => windows.push("history"));
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
      case "setUserName":
        settings.userName = command.value;
        return;
      case "addDictionaryWord":
        settings.addWord(command.word);
        return;
      case "removeDictionaryWord":
        settings.removeWord(command.word);
        return;
      case "setLearnsWords":
        settings.learnsWords = command.value;
        return;
      case "setAgentToolEnabled":
        settings.setEnabled(command.tool, command.value);
        return;
      case "setConnectorEnabled":
        settings.setConnectorEnabled(command.connector, command.value);
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
      case "fixVSCodeSettings": {
        // Read afresh: VS Code or the user may have changed the file since the window showed it.
        const text = nodeProfileFiles.readText(vscodeSettingsFile);
        if (process.platform !== "darwin" || text === null || !vscodeHidesCaret(text)) return;
        await writeFile(vscodeSettingsFile, withClassicInput(text));
        fixedVSCode = true;
        log.debug("main: set editor.editContext false in VS Code's settings");
        windows.push("welcome");
        windows.push("settings");
        return;
      }
      case "openURL":
        if (openableURLs.includes(command.url)) await shell.openExternal(command.url);
        return;
      case "keepChatOpen":
        controller.keepChatOpen();
        return;
      case "closeChat":
        controller.closeChat();
        return;
      case "openChatLink":
        // Only a web page, and only while the chat window is open.
        if (controller.chat !== null && opensLink(command.url)) await shell.openExternal(command.url);
        return;
      case "answerConfirmation":
        controller.answerConfirmation(command.confirmed);
        return;
      case "chatHeight":
        overlay.fitChat(command.height);
        return;
      case "copyHistoryEntry": {
        const text = history.text(command.id);
        if (text !== null) clipboard.writeText(text);
        closeHistory();
        return;
      }
      case "closeHistory":
        closeHistory();
        return;
      case "historyHeight":
        windows.setBounds("history", historyBounds(command.height));
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
  readSuggestedName();
  void globeKey.hotkeyIs(settings.hotkey);
  permissions.startPollingAccessibility();
  updater?.start();

  // The welcome wizard asks for consent and the permissions; it opens until finished.
  if (!settings.hasFinishedWelcome) showWelcome();
}
