// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LocalPDFReader } from "./documents/pdfReader.js";
import { parsePDF } from "./documents/pdfProcess.js";
import { NativeTextRedactor } from "./native/textRedactor.js";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { app, autoUpdater as squirrel, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from "electron";
import { autoUpdater, NsisUpdater } from "electron-updater";
import { AccountModel, AuthClient, DebugAccess } from "../core/backend/account.js";
import { opensLink } from "../core/agent/chat.js";
import { connectorsForPlatform } from "../core/agent/connectors/index.js";
import { EmailClient } from "../core/agent/connectors/thunderbird/emailClient.js";
import { type EmailOpener, NoEmailAppError } from "../core/agent/connectors/email.js";
import { liveWebFetch } from "../core/agent/connectors/web.js";
import { ThunderbirdRelay } from "../core/agent/connectors/thunderbird/relay.js";
import { CompletionsClient } from "../core/backend/completions.js";
import { TranscriptionClient } from "../core/backend/transcription.js";
import * as config from "../core/config.js";
import { CorrectionWatch } from "../core/dictionary/correctionWatch.js";
import { DictationController, isResting } from "../core/dictation/controller.js";
import { MemoryPage } from "../core/memory/page.js";
import { personalizationState } from "../core/personalization/page.js";
import { UserPrompts } from "../core/personalization/prompts.js";
import { GlobeKeyAction, savedChoiceKey } from "../core/hotkey/macos/globeKeyAction.js";
import { type DictationHotkey, hotkeyNames, isHotkeyAction } from "../core/hotkey/bindings.js";
import { type HTTPTransport, liveTransport } from "../core/backend/http.js";
import { configureLog, errorName, log, setDebugMode } from "../core/log.js";
import { aiOffLine, fileProblemNotice, resetButton, resetConfirmation, resetCopyPath, resetFailed, type StoredFile, storedFiles, unsavedBecauseOf } from "../core/ui/fileProblems.js";
import type { MenuState } from "../core/ui/menuModel.js";
import type { StoreProblem } from "../core/util/keyValueStore.js";
import { historyWindowFrame, type Point, type Rect } from "../core/ui/overlayGeometry.js";
import { PasteHistory } from "../core/dictation/pasteHistory.js";
import { PermissionsModel } from "../core/onboarding/permissions.js";
import { ScreenContextProbe } from "../core/dictation/screenContext.js";
import { AppSettings, suggestedUserName } from "../core/settings.js";
import { TipBook } from "../core/onboarding/tips.js";
import { vscodeHidesCaret, vscodeSettingsPath, withClassicInput } from "../core/onboarding/vscodeSettings.js";
import { WelcomeWizard } from "../core/onboarding/welcomeWizard.js";
import {
  type AudioCommand,
  type AudioReport,
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
import { JSONFileStore } from "./storage/jsonFileStore.js";
import { HelperClient } from "./native/helperClient.js";
import { MemoryHelper, memoryFolders } from "./native/memoryHelper.js";
import { FieldReader } from "./native/fieldReader.js";
import { TargetWindows } from "./native/targetWindow.js";
import { ScreenReader } from "./native/screenReader.js";
import { NativeMicrophone } from "./native/microphone.js";
import { KeychainSessionStore } from "./storage/keychainSessionStore.js";
import { LastRecording } from "./storage/lastRecording.js";
import { LogFile } from "./storage/logFile.js";
import { type EmailAppInfo, MacSystem } from "./native/macos/system.js";
import { OverlayWindowController } from "./overlayWindow.js";
import { macPermissions } from "./native/macos/permissions.js";
import { windowsPermissions } from "./native/windows/permissions.js";
import { WindowsSystem } from "./native/windows/system.js";
import { LinuxFileStore, linuxSearchRunner } from "./native/linux/files.js";
import { NativeContactStore, NativeEventStore, NativeNoteStore, productivityRunner } from "./native/productivity.js";
import { LinuxSystem } from "./native/linux/system.js";
import { LinuxPermissions } from "./native/linux/permissions.js";
import { LinuxAutostart } from "./native/linux/autostart.js";
import { integrateAppImage, needsX11Relaunch, runningAppImage, x11Argument } from "./native/linux/appImage.js";
import { AppImageInstaller, appImageUpdatePlatform, relaunchAfterExit } from "./native/linux/update.js";
import { linuxFallbackAnchor } from "./native/linux/overlayArea.js";
import { shellPlacementArea } from "./native/windows/overlayArea.js";
import { ShellGeometry } from "./native/windows/shellGeometry.js";
import { WindowsFileStore } from "./native/windows/files.js";
import { MacNoteStore } from "../core/agent/connectors/macos/notes.js";
import { osascript } from "./native/macos/osascript.js";
import { nodeProfileFiles } from "./storage/profileFiles.js";
import { TrayMenu } from "./tray.js";
import { runFile, type UpdatePlatform, Updater } from "./updater.js";
import { macUpdatePlatform } from "./native/macos/update.js";
import { windowsUpdatePlatform } from "./native/windows/update.js";
import { GnomeIntegration } from "./native/linux/gnomeIntegration.js";
import { Windows } from "./windows.js";

/** Debug builds are the unpackaged app (`npm start`); a packaged build is a release. */
const isDebugBuild = !app.isPackaged;
/** Available tools and Settings switches share the same platform capability selection. */
const platformConnectors = connectorsForPlatform(process.platform);
const availableConnectors = platformConnectors.map((connector) => connector.id);
/** Shown for a failure without a message of its own. */
const genericError = "Something went wrong. Try again.";
/** The pages a window may open in the browser. */
const openableURLs: readonly string[] = [config.termsURL, config.privacyURL];

// Linux launchers pass --ozone-platform=x11 before Electron initializes its display
// backend. Appending it here is too late to select XWayland on a Wayland session.

/** The AppImage this is, on Linux when not installed by the package (ADR-DESK-059). */
const appImage = process.platform === "linux" && app.isPackaged ? runningAppImage(process.env, process.execPath) : undefined;

if (needsX11Relaunch(appImage, process.argv)) {
  relaunchAfterExit({ pid: process.pid, executable: appImage, args: [...process.argv.slice(1), x11Argument] });
  app.exit(0);
} else if (app.requestSingleInstanceLock()) {
  app.whenReady().then(launch, (error: unknown) => {
    log.error(`main: launch failed: ${errorName(error)}`);
  });
} else {
  app.quit();
}

/** Settings › Memory's commands refused while AI features are off (the settings file can't be read,
 * or the user opted out of AI): a typed search, which memory's helper runs a model over, and the size
 * limit, which trims it. Listing the newest, removing one and Clear All stay: they are local and send
 * nothing of the user's (starting memory's helper may still fetch its model from TabMail's CDN), so the
 * user can always delete what memory holds (owner, 2026-10-28). */
const memoryCommands: ReadonlySet<Command["type"]> = new Set(["searchMemory", "setMemorySizeLimit"]);

/** The file each command writes the user's choice to, if any: while it couldn't be read at launch,
 * the command says so (ADR-DESK-063 amendment). Every command is named, so a new one is decided. */
const commandWrites: Record<Command["type"], StoredFile | null> = {
  sendCode: null,
  verify: null,
  signOut: null,
  setHotkey: "settings",
  setReadsScreen: "settings",
  setUserName: "settings",
  addDictionaryWord: "settings",
  removeDictionaryWord: "settings",
  setLearnsWords: "settings",
  setSmartDictation: "settings",
  setOptsOutOfAI: "settings",
  setClosesChatElsewhere: "settings",
  setEventDuration: "settings",
  excludeApp: "settings",
  removeExcludedApp: "settings",
  excludeSite: "settings",
  removeExcludedSite: "settings",
  setEmailClient: "settings",
  setAgentToolEnabled: "settings",
  setConnectorEnabled: "settings",
  setOpenAtLogin: null,
  setDebugMode: "settings",
  loadMemory: null,
  searchMemory: null,
  setMemorySizeLimit: "settings",
  removeMemory: null,
  clearMemory: null,
  editWritingStyle: "knowledgeBase",
  editKnowledgeBase: "knowledgeBase",
  resetWritingStyle: "knowledgeBase",
  resetKnowledgeBase: "knowledgeBase",
  restorePromptHistory: "knowledgeBase",
  setConsent: "settings",
  requestMicrophone: null,
  requestAccessibility: null,
  enableGnomeIntegration: null,
  checkForUpdates: null,
  installUpdate: null,
  // Next keeps the name given and, at the last step, that the wizard is finished.
  welcomeNext: "settings",
  welcomeBack: null,
  welcomeGoTo: null,
  fixVSCodeSettings: null,
  openURL: null,
  keepChatOpen: null,
  closeChat: null,
  openChatLink: null,
  answerConfirmation: null,
  chatHeight: null,
  overlayDrawn: null,
  pointerOver: null,
  chatDragStart: null,
  dragChat: null,
  copyNotPasted: null,
  dismissNotPasted: null,
  copyHistoryEntry: null,
  closeHistory: null,
  historyHeight: null,
};

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
  // A menu-bar app: no Dock icon (packaged builds say so in Info.plist as well), but for while Settings,
  // the welcome wizard or the last screen context is open (`Windows`, ADR-DESK-065). In the Dock the app
  // has the menu bar: its own menu (About, Hide, Quit), File (Close Window, Cmd-W), Edit (copy and paste
  // in the fields) and Window, in place of Electron's default, whose View and Help menus (reload,
  // developer tools, Electron's website) are not the app's.
  app.dock?.hide();
  if (process.platform === "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "fileMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));

  const lastRecording = new LastRecording(join(tmpdir(), config.debugLastRecordingFileName));
  const thunderbirdDirectory = join(homedir(), config.thunderbirdDataDirectory);
  // Native Thunderbird integration on Windows/Linux is deferred by the owner.
  const hasTabMail = (): boolean => process.platform === "darwin" && EmailClient.hasTabMail(thunderbirdDirectory, nodeProfileFiles);
  const vscodeSettingsFile = join(app.getPath("appData"), ...vscodeSettingsPath);
  /** Whether the welcome wizard or Settings changed VS Code's settings, to say so. */
  let fixedVSCode = false;
  /** The name the welcome wizard offers and Settings shows where none is set, once read
   * (`readSuggestedName`). */
  let suggestedName = "";

  const store = new JSONFileStore(join(app.getPath("userData"), "settings.json"));
  // GNOME integration holds Right Alt (the portal cannot bind a lone modifier), so other Linux
  // desktops, and a GNOME the integration doesn't support, have F8 and F9 only.
  const isGnome = process.platform === "linux" && process.env.XDG_CURRENT_DESKTOP?.toLowerCase().split(":").includes("gnome") === true;
  const gnomeHotkeys = ["rightAlt", "F8", "F9"] as const;
  const portalHotkeys = ["F8", "F9"] as const;
  const settings = new AppSettings(store, hasTabMail, process.platform === "darwin" ? ["rightOption", "function"] : isGnome ? gnomeHotkeys : process.platform === "linux" ? portalHotkeys : ["rightAlt", "rightControl"], process.platform === "darwin" ? config.builtInExcludedApps : process.platform === "win32" ? config.windowsBuiltInExcludedApps : []);
  // While the settings file can't be read its AI features are off (owner, 2026-10-27): transcription,
  // its warm-up and completions are refused, whatever asks for them (dictation and agent mode, which
  // the rest goes through, are refused at their start). Signing in and updates work as ever;
  // Settings › Memory searches nothing and sets no size limit (below).
  const aiTransport: HTTPTransport = (request) => (settings.fileProblem === undefined ? liveTransport(request) : Promise.reject(new Error(`${aiOffLine}.`)));
  const account = new AccountModel(new AuthClient(liveTransport), new KeychainSessionStore());

  const helpers = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "dist"), "helpers");
  const hotkeyHelper = new HelperClient({ name: "voice-hotkey", executable: join(helpers, process.platform === "win32" ? "voice-hotkey.exe" : "voice-hotkey") });
  const macHelper = new HelperClient({ name: "voice-macos", executable: join(helpers, "voice-macos") });
  const mac = new MacSystem(macHelper);
  const nativeHelper = process.platform === "win32"
    ? new HelperClient({ name: "voice-windows", executable: join(helpers, "voice-windows.exe"), cancelRequests: true })
    : process.platform === "linux"
      ? new HelperClient({ name: "voice-linux", executable: join(helpers, "voice-linux"), cancelRequests: true })
      : macHelper;
  // The screen is read by a program of its own, so a slow read never holds up a paste
  // (`ScreenReader`, ADR-DESK-053).
  const screenReaderHelper = new HelperClient({ name: "voice-screen-reader", executable: join(helpers, process.platform === "win32" ? "voice-screen-reader.exe" : "voice-screen-reader"), stopEndsAtOnce: true });
  const screenReader = new ScreenReader(screenReaderHelper);
  // So is the focused field for correction learning (`FieldReader`).
  const fieldReaderHelper = new HelperClient({ name: "voice-field-reader", executable: join(helpers, process.platform === "win32" ? "voice-field-reader.exe" : "voice-field-reader"), stopEndsAtOnce: true });
  const accessibilityActivator = process.platform === "win32"
    ? new HelperClient({ name: "voice-accessibility-activator", executable: join(helpers, "voice-windows.exe"), args: ["--accessibility-activator"] })
    : null;
  const gnomeIntegration = isGnome ? new GnomeIntegration(hotkeyHelper) : null;
  const linuxPermissions = process.platform === "linux" ? new LinuxPermissions(nativeHelper, hotkeyHelper, () => {
    const handle = BrowserWindow.getFocusedWindow()?.getNativeWindowHandle();
    return handle && handle.length >= 4 ? `x11:${handle.readUInt32LE(0).toString(16)}` : "";
  }, gnomeIntegration) : null;
  const permissions = new PermissionsModel(process.platform === "win32" ? windowsPermissions : linuxPermissions ?? macPermissions);
  if (linuxPermissions) linuxPermissions.onChange = () => { permissions.refresh(); pushSettingsWindows(); };
  const system = process.platform === "win32" ? new WindowsSystem(nativeHelper) : process.platform === "linux" ? new LinuxSystem(nativeHelper, hotkeyHelper) : mac;
  // It reads the paste's own target, named as the main helper named it: a Linux window token is each
  // process's own, so there the reader is given its window's process.
  const fieldReader = new FieldReader(fieldReaderHelper, process.platform, (target) => process.platform === "win32" ? targetWindows.windowOf(target) : targetWindows.appOf(target));
  const nativeAudio = ["darwin", "win32", "linux"].includes(process.platform);
  const linuxAutostart = process.platform === "linux" ? new LinuxAutostart(process.env.XDG_CONFIG_HOME?.startsWith("/") ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"), appImage ?? process.execPath, isDebugBuild ? [app.getAppPath()] : []) : null;
  if (appImage !== undefined) {
    try {
      integrateAppImage({ appImage, resources: process.resourcesPath, dataHome: process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share") });
    } catch (error) {
      log.error(`main: the AppImage's desktop entry couldn't be written: ${errorName(error)}`);
    }
  }
  // The microphone has a helper to itself on every platform, so nothing another helper waits on
  // can hold up or end a recording; it is started afresh after each dictation (ADR-DESK-032).
  // Memory, kept by Thunderbird's search helper built for this app, in this app's own folder: per
  // user of this computer, whoever is signed in (ADR-DESK-061).
  const memoryDirectory = join(app.getPath("userData"), "memory");
  const memory = new MemoryHelper({ executable: join(helpers, process.platform === "win32" ? "voice-memory.exe" : "voice-memory"), directory: memoryDirectory });
  // No settings file while memory's database is there: the file was removed by hand, the fix
  // dialog's first way (ADR-DESK-063), and the size limit the user chose went with it. Unknown, as
  // after the factory reset, so memory is never trimmed to the default. Before Settings › Memory
  // first reads the limit.
  if (store.isNew && existsSync(memoryFolders(memoryDirectory).databaseFile)) settings.unsetMemorySizeLimit();
  // Settings › Memory reads nothing until memory's database exists: the helper creates it at its
  // first start, when agent mode is first chosen.
  const memoryPage = new MemoryPage(memory, () => existsSync(memoryFolders(memoryDirectory).databaseFile), settings);
  // The writing style and knowledge base, in a file of their own: per user of this computer, as
  // memory is (ADR-DESK-063).
  const promptsStore = new JSONFileStore(join(app.getPath("userData"), "userPrompts.json"));
  const prompts = new UserPrompts(promptsStore);
  const microphoneHelper = new HelperClient({ name: "voice-microphone", executable: join(helpers, process.platform === "win32" ? "voice-microphone.exe" : "voice-microphone"), restartExitCode: config.microphoneHelperRestartExitCode });

  let wizard: WelcomeWizard | null = null;
  let stopObservingWizard: (() => void) | null = null;
  let emailApps: { systemDefault: EmailAppInfo | null; installed: EmailAppInfo[] } = { systemDefault: null, installed: [] };
  let emailAppIcon: { path: string | null; dataURL: string | null } = { path: null, dataURL: null };

  const windows = new Windows(stateOf);
  // GNOME integration is part of the keyboard permission.
  if (gnomeIntegration) gnomeIntegration.onChange = () => {
    // Right Alt can never be held on a GNOME the extension doesn't support: F8 there (owner, 2026-10-05).
    settings.offerHotkeys(gnomeIntegration.state === "unsupported" ? portalHotkeys : gnomeHotkeys);
    permissions.refresh();
    pushSettingsWindows();
  };

  function sendAudio(command: AudioCommand): void {
    const contents = windows.audio().webContents;
    if (contents.isLoading()) contents.once("did-finish-load", () => contents.send(channels.audioCommand, command));
    else contents.send(channels.audioCommand, command);
  }
  // Native capture preserve session ownership without opening a renderer device.
  const receiveAudio = (report: AudioReport): void => capture.receive(report);
  const capture: SessionAudioCapture = new SessionAudioCapture(
    nativeAudio ? new NativeMicrophone(microphoneHelper, "voice-microphone").microphone(receiveAudio) : sendAudio,
  );
  // A helper that exits takes a running microphone with it.
  if (nativeAudio) microphoneHelper.onExit = () => capture.lost();
  // `voice-linux` holds the insertion permission's portal session.
  nativeHelper.onExit = () => linuxPermissions?.reset();

  // `email_compose`'s draft (ADR-DESK-027), opened with the app macOS opens `mailto:` links with,
  // which the result names.
  const emailOpener: EmailOpener = {
    open: async (url) => {
      const name = process.platform === "darwin" ? (await mac.emailApps([])).systemDefault?.name : app.getApplicationNameForProtocol("mailto://");
      if (!name) throw new NoEmailAppError();
      await shell.openExternal(url);
      return name;
    },
  };

  const targetWindows = new TargetWindows(nativeHelper, screenReader, process.platform);

  const probe = new ScreenContextProbe(
    () => permissions.accessibilityTrusted,
    (exclusions, wholeWindowOf, target) => screenReader.read(exclusions, wholeWindowOf, target?.then((handle) => targetWindows.native(handle))),
    () => windows.push("contextDebug"),
    (read) => screenReader.stop(read),
  );

  const history = new PasteHistory();
  const tips = new TipBook(store);
  const controller = new DictationController({
    permissions,
    settings: () => settings.dictation(account.email),
    account,
    tips,
    paste: (text, signal, target) => targetWindows.paste(text, signal, target),
    copy: (text) => copyText(text),
    saveClipboard: () => system.saveClipboard(),
    history,
    thunderbird: new ThunderbirdRelay(mac.thunderbird),
    capture,
    frontmostApp: () => targetWindows.capture(),
    keyboardLanguage: () => system.keyboardLanguage(),
    systemEmailApp: () => process.platform === "darwin" ? mac.systemEmailApp() : Promise.resolve(null),
    makeTranscriptionClient: (baseURL) => new TranscriptionClient(baseURL, app.getVersion(), aiTransport),
    warmUp: (baseURL, accessToken) => new TranscriptionClient(baseURL, app.getVersion(), aiTransport).warmUp(accessToken),
    makeCompletionsClient: (baseURL) => new CompletionsClient(baseURL, app.getVersion(), aiTransport),
    // Native connectors require a platform implementation; shared web/email tools use Electron.
    connectorTools: platformConnectors.flatMap((connector) =>
      connector.tools({
        eventStore: process.platform === "win32" ? new NativeEventStore(productivityRunner(join(helpers, "voice-productivity.exe")), "TabMail Voice calendar (local to this PC)") : process.platform === "linux" ? new NativeEventStore(productivityRunner(join(helpers, "voice-productivity")), undefined, true) : mac.eventStore,
        contactStore: process.platform === "win32" ? new NativeContactStore(productivityRunner(join(helpers, "voice-productivity.exe")), "TabMail Voice contacts (local to this PC)") : process.platform === "linux" ? new NativeContactStore(productivityRunner(join(helpers, "voice-productivity"))) : mac.contactStore,
        fileStore: process.platform === "win32" ? new WindowsFileStore(homedir()) : process.platform === "linux" ? new LinuxFileStore(homedir(), linuxSearchRunner(join(helpers, "voice-files"))) : mac.fileStore,
        home: homedir(),
        pdfReader: new LocalPDFReader(homedir(), parsePDF, new NativeTextRedactor(nativeHelper)),
        emailOpener,
        scriptRunner: osascript,
        noteStore: process.platform === "linux" ? new NativeNoteStore(productivityRunner(join(helpers, "voice-productivity"))) : new MacNoteStore(osascript),
        webFetch: liveWebFetch,
        webOpener: { open: (url) => shell.openExternal(url) },
        settings,
      }),
    ),
    // Learn corrections locally, the field read by voice-field-reader (ADR-DESK-038).
    corrections: nativeAudio ? new CorrectionWatch(fieldReader, (words) => settings.learnWords(words)) : undefined,
    useWords: (texts) => settings.useWords(texts),
    memory,
    prompts,
    keepRecording: (wav) => lastRecording.keep(wav),
  });
  controller.captureContext = (exclusions, target) => probe.capture(exclusions, target);
  controller.stopContext = (read) => probe.stop(read);
  controller.captureWindow = (capture) => probe.window(capture);

  const shellGeometry = system instanceof WindowsSystem ? new ShellGeometry(() => system.shellExclusionBounds()) : null;
  const overlay = new OverlayWindowController(windows.overlay(), async () => {
    if (system instanceof LinuxSystem) return system.caretAnchor();
    if (system instanceof WindowsSystem) {
      // The helper snapshots the foreground HWND when receiving this request.
      const caret = system.caretAnchor();
      // Shell geometry updates placement independently; a slow reply must not delay the caret.
      void shellGeometry?.refresh().then((changed) => {
        if (changed) overlay.refreshPlacement();
      }).catch((error: unknown) => {
        log.debug(`main: shell geometry lookup failed: ${errorName(error)}`);
      });
      return caret;
    }
    const pid = await system.frontmostApp();
    return pid === null ? null : system.caretAnchor(pid);
  }, system instanceof WindowsSystem ? (area) => shellPlacementArea(area, shellGeometry?.bounds ?? []) : undefined, process.platform === "linux" ? linuxFallbackAnchor : undefined, process.platform === "linux" ? "frame" : "pointer");

  if (system instanceof WindowsSystem) {
    let refreshing = false;
    let refreshAgain = false;
    nativeHelper.on("shellGeometryChanged", () => {
      refreshAgain = true;
      if (refreshing) return;
      refreshing = true;
      void (async () => {
        try {
          while (refreshAgain) {
            refreshAgain = false;
            try {
              if (await shellGeometry?.refresh()) overlay.refreshPlacement();
            } catch (error: unknown) {
              log.debug(`main: shell geometry refresh failed: ${errorName(error)}`);
            }
          }
        } finally {
          refreshing = false;
        }
      })();
    });
  }

  // Packaged macOS and Windows builds update from their platform's feed (ADR-DESK-041, ADR-DESK-050);
  // apt updates Linux (ADR-DESK-058).
  const updatePlatform = isDebugBuild ? null : makeUpdatePlatform();
  const updater = updatePlatform === null ? null : makeUpdater(updatePlatform);

  let showsSmokeTip = false;
  const tray = new TrayMenu(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), menuState, {
    showWelcome,
    showSettings,
    requestMicrophone: () => void permissions.requestMicrophone(),
    requestAccessibility: () => permissions.requestAccessibility(),
    showFileProblem,
    toggleDictation: () => controller.toggle(),
    quit: () => app.quit(),
    checkForUpdates: () => updater?.checkNow(),
    installUpdate: () => updater?.install(),
    debug: {
      hasLastRecording: () => lastRecording.exists,
      playLastRecording: () => void shell.openPath(lastRecording.path),
      showLastScreenContext: () => windows.showContextDebug(),
      showsSmokeTip: () => showsSmokeTip,
      toggleSmokeTip: () => { showsSmokeTip = !showsSmokeTip; windows.push("overlay"); tray.update(); },
      showLogFile: () => shell.showItemInFolder(logPath),
    },
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
      overlayPlacement: overlay.overlayPlacement,
      reveal: overlay.reveal,
      phase: controller.phase,
      mode: controller.mode,
      level: controller.level,
      isHearing: controller.isHearing,
      hasVoice: controller.hasVoice,
      isRetrying: controller.isRetrying,
      language: controller.language,
      tip: showsSmokeTip ? "handsFree" : controller.tip,
      ...(gnomeIntegration ? { gnomeRecordingKeys: gnomeIntegration.state === "ready" } : {}),
      opensUpward: overlay.opensUpward,
      bubblesFitUnder: overlay.bubblesFitUnder,
      hotkey: controller.settings.hotkey,
      tools: controller.tools,
      readsWindow: controller.readsWindow,
      connectors: controller.connectors,
      recentBubbles: controller.recentBubbles,
      runningBubble: controller.runningBubble,
      emailAppIcon: emailAppIcon.path === controller.emailAppPath ? emailAppIcon.dataURL : null,
      chat: controller.chat,
      chatPlacement: overlay.chatPlacement,
    };
  }

  function settingsState(): SettingsState {
    const systemDefault = emailApps.systemDefault;
    return {
      availableHotkeys: settings.availableHotkeys,
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
      canLearnWords: nativeAudio,
      smartDictation: settings.smartDictation,
      optsOutOfAI: settings.optsOutOfAI,
      closesChatElsewhere: settings.closesChatElsewhere,
      eventDuration: settings.eventDuration,
      excludedApps: settings.excludedApps,
      canExcludeApps: nativeAudio,
      builtInExcludedApps: settings.builtInExcludedApps,
      excludedSites: settings.excludedSites,
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
      vscodeFix: vscodeFix(),
      ...(process.platform === "linux" ? { keyboardPermission: linuxKeyboardPermission() } : {}),
      ...(gnomeIntegration ? { gnomeIntegration: gnomeIntegration.state } : {}),
      ...(linuxPermissions?.hotkeyUnavailable ? { hotkeyUnavailable: true } : {}),
      openAtLogin: linuxAutostart?.enabled ?? app.getLoginItemSettings().openAtLogin,
      debugAllowed: DebugAccess.allows(account.email),
      debugMode: settings.debugMode,
      version: app.getVersion(),
      update: updater?.state ?? null,
      memory: memoryPage.state,
      personalization: personalizationState(prompts),
      fileProblems: unreadableFiles(),
    };
  }

  /** Ubuntu's keyboard permission: GNOME integration where it is GNOME, the dictation shortcut, and
   * keyboard interaction. */
  function linuxKeyboardPermission(): NonNullable<WelcomeState["keyboardPermission"]> {
    const steps = settings.hotkey === "rightAlt" ? "allow keyboard interaction in the next system prompt" : "approve the dictation shortcut, then allow keyboard interaction in the next system prompt";
    // A GNOME the integration doesn't support goes without it, as other desktops do.
    const integration = gnomeIntegration?.state === "unsupported" ? null : gnomeIntegration;
    return {
      title: "Shortcut and keyboard control",
      // Without GNOME integration, Space does not switch modes while dictating.
      ...(integration ? {} : { agentShortcut: `Shift+${hotkeyNames[settings.hotkey].keycap}` }),
      description: integration ? "Turns on GNOME integration and allows the dictation key and pasting." : "Allows the dictation shortcut and pasting.",
      button: "Allow Keyboard Control",
      instructions: integration?.state === "restart" ? "Log out of Ubuntu and back in to finish turning on GNOME integration, then allow keyboard control here."
        : integration ? `This turns on GNOME integration; then ${steps}.`
          : `${steps.charAt(0).toUpperCase()}${steps.slice(1)}.`,
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
      canLearnWords: nativeAudio,
      readsScreen: settings.readsScreen,
      enabledTools: settings.enabledTools,
      connectors: availableConnectors,
      enabledConnectors: settings.enabledConnectors,
      userName: settings.userName,
      suggestedName,
      microphoneGranted: permissions.microphone === "granted",
      accessibilityTrusted: permissions.accessibilityTrusted,
      vscodeFix: vscodeFix(),
      ...(process.platform === "linux" ? { keyboardPermission: linuxKeyboardPermission() } : {}),
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
      fileProblems: unreadableFiles(),
      optsOutOfAI: settings.optsOutOfAI,
      hotkey: settings.hotkey,
      debugMode: settings.isDebugMode(account.email),
      phase: controller.phase,
      update: updater?.state ?? null,
    };
  }

  /** The platform's update adapter, its library's own log off (it writes to the console; ours says
   * what failed). The Linux package has none: its apt source updates it (ADR-DESK-058); the AppImage
   * updates itself (ADR-DESK-059). */
  function makeUpdatePlatform(): UpdatePlatform | null {
    switch (process.platform) {
      case "darwin":
        autoUpdater.logger = null;
        return macUpdatePlatform({ source: autoUpdater, installer: squirrel, arch: process.arch });
      case "win32": {
        const source = new NsisUpdater();
        source.logger = null;
        return windowsUpdatePlatform({ source, helper: join(helpers, "voice-windows.exe"), run: runFile });
      }
      case "linux": {
        if (appImage === undefined) return null;
        const source = new AppImageInstaller(appImage);
        source.logger = null;
        return appImageUpdatePlatform({
          source,
          appImage,
          keyring: join(process.resourcesPath, "linux", "tabmail-voice-archive-keyring.gpg"),
          arch: process.arch,
          args: [x11Argument],
          run: runFile,
          quit: () => app.quit(),
        });
      }
      default:
        return null;
    }
  }

  function makeUpdater(platform: UpdatePlatform): Updater {
    return new Updater({
      platform,
      store,
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
      isBusy: () => !isResting(controller.phase) || controller.chat !== null,
      onChange: () => pushSettingsWindows(),
    });
  }

  /** Why `file` couldn't be read at launch, when it couldn't (ADR-DESK-063). */
  function fileProblem(file: StoredFile): StoreProblem | undefined {
    return file === "settings" ? settings.fileProblem : prompts.fileProblem;
  }

  function unreadableFiles(): StoredFile[] {
    return storedFiles.filter((file) => fileProblem(file) !== undefined);
  }

  /** Tells why `file` couldn't be read and how to fix it by hand, else with the factory reset; the app
   * never resets, moves or writes over it on its own. The next launch reads it again. */
  function showFileProblem(file: StoredFile): void {
    const problem = fileProblem(file);
    if (problem === undefined) return;
    const { message, detail } = fileProblemNotice(file, problem, process.platform);
    app.focus({ steal: true });
    void dialog.showMessageBox({ type: "warning", message, detail, buttons: ["Show File", resetButton, "Close"], defaultId: 2, cancelId: 2 }).then(({ response }) => {
      if (response === 0) shell.showItemInFolder(problem.path);
      if (response === 1) void resetFile(file);
    });
  }

  /** The user's factory reset of `file` (owner, 2026-10-27), asked only from its fix dialog: one
   * confirmation saying what this computer loses and where the file is kept, then the file is moved
   * aside to a dated copy, never deleted, and what it held reads its defaults. The settings file's
   * reset then opens the welcome wizard, as at a first launch. */
  async function resetFile(file: StoredFile): Promise<void> {
    const problem = fileProblem(file);
    if (problem === undefined) return;
    const copy = resetCopyPath(problem.path, new Date());
    const { message, detail } = resetConfirmation(file, copy);
    const { response } = await dialog.showMessageBox({ type: "warning", message, detail, buttons: ["Reset", "Cancel"], defaultId: 1, cancelId: 1 });
    if (response !== 0) return;
    // A second confirmation, left open while the first reset the file, has nothing left to reset.
    if (fileProblem(file) !== problem) return;
    try {
      if (file === "settings") {
        // The Globe key's way back to the user's own action lives in this file (ADR-DESK-031): kept
        // across the reset, so the hotkey's change hands the key back.
        const globeKeyChoice = store.get(savedChoiceKey);
        settings.resetFile(() => store.moveAside(copy), globeKeyChoice === undefined ? {} : { [savedChoiceKey]: globeKeyChoice });
      } else prompts.resetFile(() => promptsStore.moveAside(copy));
    } catch (error) {
      log.error(`main: the ${file} file couldn't be reset: ${errorName(error)}`);
      void dialog.showMessageBox({ type: "warning", ...resetFailed(file), buttons: ["OK"] });
      return;
    }
    log.debug(`main: the ${file} file was reset`);
    tray.update();
    if (file === "settings") welcomeIfSetUpNever();
  }

  /** Opens the welcome wizard, as at a first launch, while setup was never done and the settings file
   * reads (one that can't be read is not setup never done: its fix is told instead). Its consent page
   * says what's new, so the tip that tells a user who set the app up before never shows to this one. */
  function welcomeIfSetUpNever(): void {
    if (settings.hasFinishedWelcome || settings.fileProblem !== undefined) return;
    tips.markLearned("agentKnowledgeBase");
    showWelcome();
  }

  /** Opens the welcome wizard at its first step; brings the open one forward instead. While the
   * settings file can't be read, which reads as setup never done, it tells how to fix the file instead,
   * and the wizard never opens (owner, 2026-10-27). */
  function showWelcome(): void {
    if (settings.fileProblem !== undefined) return showFileProblem("settings");
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
    void gnomeIntegration?.refresh();
    if (process.platform !== "darwin") return;
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

  /** Where the paste history opened: by the pill of the hold that asked for it. */
  let historyPlace: { pill: Point; workArea: Rect; bubblesUnder: boolean } | null = null;
  /** The height its list last measured: an open one moved keeps it, never flashing another. */
  let historyHeight: number = config.pasteHistoryMaxHeight;

  /** The paste history (ADR-DESK-043), where the chat window opens (`historyWindowFrame`), shown once
   * its list has measured itself (`historyHeight`, `Windows.fitHistory`). */
  function showHistory(): void {
    historyPlace = overlay.pillPlace;
    windows.showHistory(historyBounds(historyHeight), () => windows.close("history"), historyClosed);
    // Its page measures its list again, which may have changed.
    windows.push("history");
  }

  /** The window for a card `height` tall: the card where the chat window opens, the window around
   * it larger by `pasteHistoryShadowMargin` on each side, for its glow. */
  function historyBounds(height: number): Rect {
    const size = { width: config.pasteHistoryWindowWidth, height: Math.round(Math.min(height, config.pasteHistoryMaxHeight)) };
    const frame = historyPlace ? historyWindowFrame(historyPlace.pill, size, historyPlace.workArea, historyPlace.bubblesUnder) : { x: 0, y: 0, ...size };
    const margin = config.pasteHistoryShadowMargin;
    return { x: Math.round(frame.x) - margin, y: Math.round(frame.y) - margin, width: frame.width + 2 * margin, height: Math.round(frame.height) + 2 * margin };
  }

  /** Puts `text` on the clipboard (a promise since Electron 44): true once written, false, logged,
   * when the write fails. */
  async function copyText(text: string): Promise<boolean> {
    try {
      await clipboard.writeText(text);
      return true;
    } catch (error) {
      log.error(`main: couldn't copy to the clipboard: ${errorName(error)}`);
      return false;
    }
  }

  /** The paste history closed. Closed with the focus (Escape, a click on an entry, Cmd-W), on macOS it
   * gives the app the user was in back its focus, unless another of this app's windows is open, or
   * the chat is: hiding the app would hide the chat too, with nothing to show it again while the next
   * holds talk to it. Closed as it lost the focus (a click elsewhere), the focus is already there.
   * (Quitting with it focused hides the app too, on the way out.) */
  function historyClosed(focused: boolean): void {
    if (!focused || process.platform !== "darwin") return;
    const othersOpen = (["settings", "welcome", "contextDebug"] as const).some((name) => windows.isOpen(name)) || controller.chat !== null;
    if (!othersOpen) app.hide();
  }

  /** The Thunderbird bubble shows the email app's icon: read once per app. */
  function updateEmailAppIcon(): void {
    const path = controller.emailAppPath;
    if (process.platform !== "darwin" || path === null || path === emailAppIcon.path) return;
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
    const fullName = nativeAudio ? system.fullUserName() : Promise.resolve("");
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
      .then(({ installed }) => log.debug(`main: hotkey ${hotkey} ${installed ? "installed" : process.platform === "linux" ? "not installed (compositor shortcut access unavailable)" : "not installed (no Accessibility grant yet)"}`))
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
  hotkeyHelper.onExit = () => linuxPermissions?.resetHotkey();
  hotkeyHelper.onStart = () => {
    configureHotkey(settings.hotkey);
    setChatOpen(controller.chat !== null);
  };
  hotkeyHelper.on("action", (message) => {
    if (isHotkeyAction(message.action)) controller.handle(message.action);
  });
  // While the chat window is open: a click elsewhere, or another app or window in front, closes it
  // when idle, if the user wants that (ADR-DESK-022). macOS and Windows tell every click, the chat's
  // own too: a click the overlay takes is on the chat. GNOME tells only clicks elsewhere (the window
  // in front raised, or the Shell's own UI), and there the overlay's frame takes every click on it,
  // so whether it takes clicks says nothing of where this one was.
  const dismissChat = () => {
    if (settings.closesChatElsewhere) controller.dismissChat();
  };
  hotkeyHelper.on("chatMouseDown", () => {
    if (process.platform === "linux" || !overlay.isTakingClicks) dismissChat();
  });
  hotkeyHelper.on("chatFocusChanged", dismissChat);
  nativeHelper.onStart = () => {
    linuxPermissions?.restore();
    if (process.platform === "darwin") startActivator();
  };
  // Prepare capture on launch and after each restart of the helper it runs in.
  microphoneHelper.onStart = () => controller.prewarm();

  // The hotkey follows Settings, and so does the Globe key's own action: off while fn is the
  // hotkey, the user's choice back at another key and when the app quits (ADR-DESK-031).
  const globeKey = process.platform === "darwin" ? new GlobeKeyAction(mac.globeKey, store) : null;
  settings.onHotkeyChange = (hotkey) => {
    configureHotkey(hotkey);
    void globeKey?.hotkeyIs(hotkey);
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
        gnomeIntegration?.recordingStarted().catch((error: unknown) => {
          log.error(`main: recording shortcut setup failed: ${errorName(error)}`);
        });
        return;
      default:
        // Finished, failed or canceled without the hotkey: hands-free listening is over too.
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
  // A packaged build writes the debug log while debug mode is on: switched on, or the account it is
  // allowed for signing in (ADR-DESK-015).
  const followDebugMode = () => {
    const on = settings.isDebugMode(account.email);
    setDebugMode(on);
    // The last recording, screen context and sample tip live only while debug mode is on: switched
    // off, or the account no longer allowed it, they are dropped (the recording also at launch, after
    // a switch changed while the app was closed), and a recording still being made is not kept.
    lastRecording.follow(on);
    if (on) return;
    if (probe.lastContext !== null) {
      probe.lastContext = null;
      windows.push("contextDebug");
    }
    if (showsSmokeTip) {
      showsSmokeTip = false;
      windows.push("overlay");
      tray.update();
    }
  };
  followDebugMode();
  settings.observe(followDebugMode);
  account.observe(followDebugMode);
  permissions.observe(pushSettingsWindows);
  memoryPage.observe(() => windows.push("settings"));
  prompts.observe(() => windows.push("settings"));

  // The hotkey's event tap can't be created until Accessibility is granted: configure again once
  // the grant lands.
  permissions.onAccessibilityGranted = () => {
    configureHotkey(settings.hotkey);
    if (process.platform === "darwin") startActivator();
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
  /** The search Settings › Memory's list is read for: the one shown, but while AI features are off
   * the newest only, so a search typed before isn't run again (owner, 2026-10-28). */
  function memoryListQuery(): string | undefined {
    return settings.memoryOffLine === null ? undefined : "";
  }
  /** Says how to fix the file `command` writes, while that file couldn't be read at launch. */
  function unsavedFor(command: Command): string | null {
    const file = commandWrites[command.type];
    return file !== null && fileProblem(file) !== undefined ? unsavedBecauseOf(file) : null;
  }
  ipcMain.handle(channels.command, async (_event, command: unknown): Promise<CommandResult> => {
    if (!isCommand(command)) return { error: genericError };
    const memoryOff = settings.memoryOffLine;
    if (memoryOff !== null && memoryCommands.has(command.type)) return { error: unsavedFor(command) ?? `${memoryOff}.` };
    // A command that writes a file that couldn't be read at launch isn't saved, whatever it did for
    // this session, and says how to fix the file, every time.
    const unsaved = unsavedFor(command);
    try {
      await run(command);
      return { error: unsaved };
    } catch (error) {
      log.error(`main: ${command.type} failed: ${errorName(error)}`);
      return { error: unsaved ?? (error instanceof Error && error.message !== "" ? error.message : genericError) };
    }
  });
  ipcMain.on(channels.audioReport, (event, report: unknown) => {
    if (windows.isAudioWindow(event.sender) && isAudioReport(report)) capture.receive(report);
  });

  /** An exclusion, a removal or a personalization edit that could not be written to disk did not
   * happen, and the user is told (a file that couldn't be read at launch is told of by the command
   * handler, `commandWrites`). */
  const exclusionUnsaved = "This couldn't be saved, so it is not excluded. Check the disk and try again.";
  const personalizationUnsaved = "This couldn't be saved, so nothing changed. Check the disk and try again.";
  const removalUnsaved = "This couldn't be saved, so it is still excluded. Check the disk and try again.";

  /** Asks the user for an app, and excludes it from screen reading. */
  async function excludePickedApp(): Promise<void> {
    if (!nativeAudio) return;
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Exclude an App",
      buttonLabel: "Exclude",
      defaultPath: process.platform === "win32" ? process.env.ProgramFiles : process.platform === "linux" ? "/usr/share/applications" : config.applicationsDirectory,
      properties: ["openFile"],
      filters: [{ name: "Applications", extensions: [process.platform === "win32" ? "exe" : process.platform === "linux" ? "desktop" : "app"] }],
    });
    const path = filePaths[0];
    if (canceled || path === undefined) return;
    const picked = await system.appInfo(path);
    if (picked === null) throw new Error("That app can't be excluded: its application identifier could not be read.");
    const result = settings.excludeApp({ bundleIdentifier: picked.bundleIdentifier, name: picked.name });
    if (result === "full") throw new Error(`At most ${config.exclusionsMax} apps can be excluded. Remove one to add another.`);
    if (result === "invalid") throw new Error("That app can't be excluded.");
    if (result === "unsaved") throw new Error(exclusionUnsaved);
  }

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
      case "setSmartDictation":
        settings.smartDictation = command.value;
        return;
      case "setOptsOutOfAI":
        if (!settings.setOptsOutOfAI(command.value)) throw new Error(personalizationUnsaved);
        return;
      case "setClosesChatElsewhere":
        settings.closesChatElsewhere = command.value;
        return;
      case "setEventDuration":
        if (!settings.setEventDuration(command.value)) throw new Error("The default event duration couldn't be saved. Check the disk and try again.");
        return;
      case "loadMemory":
        return memoryPage.load(memoryListQuery());
      case "searchMemory":
        return memoryPage.load(command.query);
      case "setMemorySizeLimit":
        return memoryPage.setSizeLimit(command.value);
      case "removeMemory":
        return memoryPage.remove(command.memId, memoryListQuery());
      case "clearMemory":
        return memoryPage.clear(memoryListQuery());
      case "editWritingStyle":
        if (!prompts.editCompositionSection(command.section, command.shown, command.bullets)) throw new Error(personalizationUnsaved);
        return;
      case "editKnowledgeBase":
        if (!prompts.editKnowledgeBase(command.shown, command.bullets)) throw new Error(personalizationUnsaved);
        return;
      case "resetWritingStyle":
        if (!prompts.resetComposition()) throw new Error(personalizationUnsaved);
        return;
      case "resetKnowledgeBase":
        if (!prompts.resetKnowledgeBase()) throw new Error(personalizationUnsaved);
        return;
      case "restorePromptHistory":
        if (!prompts.restore(command.id)) throw new Error(personalizationUnsaved);
        return;
      case "excludeApp":
        return excludePickedApp();
      case "removeExcludedApp":
        if (!settings.removeExcludedApp(command.bundleIdentifier)) throw new Error(removalUnsaved);
        return;
      case "excludeSite": {
        const result = settings.excludeSite(command.site);
        if (result === "full") throw new Error(`At most ${config.exclusionsMax} websites can be excluded. Remove one to add another.`);
        if (result === "invalid") throw new Error("That isn't a website's address.");
        if (result === "unsaved") throw new Error(exclusionUnsaved);
        return;
      }
      case "removeExcludedSite":
        if (!settings.removeExcludedSite(command.host)) throw new Error(removalUnsaved);
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
        if (linuxAutostart) linuxAutostart.enabled = command.value;
        else app.setLoginItemSettings({ openAtLogin: command.value });
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
      case "enableGnomeIntegration":
        return gnomeIntegration?.enable();
      case "requestAccessibility":
        return permissions.requestAccessibility();
      case "checkForUpdates":
        return updater?.checkNow();
      case "installUpdate":
        return updater?.install();
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
      case "overlayDrawn":
        overlay.drawn(command.reveal);
        return;
      case "pointerOver":
        overlay.pointerOver(command.over);
        return;
      case "chatDragStart":
        overlay.startChatDrag();
        return;
      case "dragChat":
        overlay.dragChat({ x: command.dx, y: command.dy });
        return;
      case "copyNotPasted":
        void controller.copyNotPasted();
        return;
      case "dismissNotPasted":
        controller.dismissNotPasted();
        return;
      case "copyHistoryEntry": {
        const text = history.text(command.id);
        if (text !== null) void copyText(text);
        windows.close("history");
        return;
      }
      case "closeHistory":
        windows.close("history");
        return;
      case "historyHeight":
        historyHeight = command.height;
        windows.fitHistory(historyBounds(command.height));
        return;
    }
  }

  // MARK: Launch

  app.on("did-become-active", () => permissions.refresh());
  app.on("second-instance", showSettings);

  let quitting = false;
  app.on("before-quit", (event) => {
    // Every time, the last just before the library's quit-time install.
    updater?.quitting();
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (globeKey?.restore() ?? Promise.resolve())
      .then(() => {
        hotkeyHelper.stop();
        nativeHelper.stop();
        screenReaderHelper.stop();
        fieldReaderHelper.stop();
        microphoneHelper.stop();
        memory.stop();
        prompts.flushHistory();
        accessibilityActivator?.stop();
        return logFile.flush();
      })
      .finally(() => app.quit());
  });

  hotkeyHelper.start();
  nativeHelper.start();
  screenReaderHelper.start();
  fieldReaderHelper.start();
  void gnomeIntegration?.refresh();
  microphoneHelper.start();
  accessibilityActivator?.start();
  readSuggestedName();
  void globeKey?.hotkeyIs(settings.hotkey);
  permissions.startPollingAccessibility();
  updater?.start();

  // The welcome wizard asks for consent and the permissions; it opens until finished.
  welcomeIfSetUpNever();
  // A file that couldn't be read is told of once launch is done, the windows' commands wired; its Fix
  // item stays in the menu.
  for (const file of unreadableFiles()) showFileProblem(file);
}
