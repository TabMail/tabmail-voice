// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The installer's Visual C++ runtime step (ADR-DESK-057), compiled by the NSIS electron-builder
// packages with and run for real on Windows. Microsoft's installer is replaced by a synthetic one
// with the same version resource, which records how it was run and writes the runtime state a run
// asks for; that state lives in a key of this test's own under the current user (in CLSID, which,
// like the real key, has a 32-bit and a 64-bit registry view). That key, and the restart notice
// recorded instead of shown (as Windows would show it: only when the install is not silent), are
// the changes made to resources/windows/installer.nsh before compiling it (where Windows keeps the
// real state is pinned in packaging.test.ts). What electron-builder's script gives the step is
// stood in for: the --updated and --force-run flags, and opening a program (recorded, then run).
// The installed app is a program of the test's own holding a single-instance lock (a named mutex, as
// Electron's), which can be left running for a while, as the app quitting for its update is; opened
// again, it records whether it got the lock. Microsoft's installer records whether it ran while the
// app did.

const desktop = resolve(__dirname, "../..");
const hook = join(desktop, "resources/windows/installer.nsh");
const realKey = "SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\";
const testKey = `Software\\Classes\\CLSID\\{${randomUUID().toUpperCase()}}`;
const lock = `TabMailVoiceTest-${randomUUID()}`;
// Compiling may first download electron-builder's NSIS, and each run starts two programs.
const compileTimeout = 300_000;
const runTimeout = 60_000;

type Arch = "arm64" | "x64";
/** A runtime version as Windows records it; a part left out is not recorded. */
type Version = [major: number, minor: number, build?: number, revision?: number];
type View = 32 | 64;
/** A runtime registered as installed (or, with `installed: 0`, registered and not installed), in the
 *  32-bit registry view where Microsoft documents it unless another is given. */
type Registered = { version: Version; installed?: 0 | 1; view?: View };
type Scenario = {
  arch: Arch;
  before?: Partial<Record<Arch, Registered | Registered[]>>;
  /** What the synthetic Microsoft installer registers, in which view (32-bit unless given), and the
   *  exit code it returns. */
  installs?: Partial<Record<Arch, Version>>;
  installsIn?: View;
  exit?: number;
  silent?: boolean;
  /** Run as an update the app runs as it quits (--updated), or as its Restart Now runs one, which
   *  opens the app afterwards (--updated --force-run). */
  updated?: boolean;
  forceRun?: boolean;
  /** How long the installed app keeps running once the installer starts, in milliseconds. */
  running?: number;
  /** The app's file can't be opened for writing (read-only), as while it runs, though it doesn't. */
  readOnlyApp?: boolean;
};

// The registry values Windows records a runtime version in, part by part.
const parts = ["Major", "Minor", "Bld", "Rbld"];
// The version the synthetic Microsoft installer carries, and one older.
const carried: Version = [14, 44, 35211, 5];
const older: Version = [14, 44, 35211, 4];

// The restart notice the installer shows when the runtime's installer asks for a restart.
const notice = "MessageBox MB_OK|MB_ICONINFORMATION";
const restartNotice = "TabMail Voice is installed. Restart Windows when you can to finish installing the Microsoft Visual C++ Runtime.";

const nsisString = (value: string): string => value.replaceAll("$", "$$");
const appFile = "TabMail Voice.exe";
// How long an update waits for the app it replaces (VOICE_APP_QUIT_CHECKS × VOICE_APP_QUIT_INTERVAL).
const quitWait = 10_000;

describe.runIf(process.platform === "win32")("the Windows installer's Visual C++ runtime step", () => {
  let work: string;
  let state: string;
  const installers: Partial<Record<Arch, string>> = {};

  function makensis(script: string, defines: Record<string, string>, nsis: { path: string; env?: Record<string, string> }): void {
    const args = ["-WX", "-V2", "-INPUTCHARSET", "UTF8", ...Object.entries(defines).map(([name, value]) => `-D${name}=${value}`), script];
    const run = spawnSync(nsis.path, args, { env: { ...process.env, ...nsis.env }, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`makensis ${script} failed:\n${run.stdout}${run.stderr}`);
  }

  function reg(...args: string[]): void {
    execFileSync("reg.exe", args, { stdio: "pipe" });
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "voice-installer-runtime-"));
    state = join(work, "state");
    mkdirSync(state);
    const builder = JSON.parse(readFileSync(join(desktop, "electron-builder.json"), "utf8")) as { toolsets?: { nsis?: string }; nsis?: { customNsisBinary?: unknown } };
    const { getMakeNsisPath } = createRequire(__filename)("app-builder-lib/out/toolsets/windows.js") as {
      getMakeNsisPath(nsis: string | undefined, custom: unknown): Promise<{ path: string; env?: Record<string, string> }>;
    };
    const nsis = await getMakeNsisPath(builder.toolsets?.nsis, builder.nsis?.customNsisBinary);

    // Microsoft's installer, as far as the step can tell: its version resource is 14.44.35211.5 (a
    // revision above 0, so that an older revision can be registered).
    mkdirSync(join(work, "project/dist/runtime"), { recursive: true });
    writeFileSync(join(work, "runtime.nsi"), `Unicode true
!include LogicLib.nsh
Name "Synthetic runtime"
OutFile "\${OUT}"
RequestExecutionLevel user
SilentInstall silent
VIProductVersion "14.44.35211.5"
VIAddVersionKey "ProductName" "Synthetic runtime"
VIAddVersionKey "FileVersion" "14.44.35211.5"
VIAddVersionKey "FileDescription" "Synthetic runtime"
VIAddVersionKey "LegalCopyright" "TabMail"
!macro register ARCH
  \${If} \${FileExists} "\${STATE}\\installs-\${ARCH}"
    SetRegView 32
    \${If} \${FileExists} "\${STATE}\\installs-in-64"
      SetRegView 64
    \${EndIf}
    FileOpen $0 "\${STATE}\\installs-\${ARCH}" r
    FileRead $0 $1
    FileRead $0 $2
    FileRead $0 $5
    FileRead $0 $6
    FileClose $0
    IntOp $1 $1 + 0
    IntOp $2 $2 + 0
    IntOp $5 $5 + 0
    IntOp $6 $6 + 0
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Installed" 1
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Major" $1
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Minor" $2
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Bld" $5
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Rbld" $6
  \${EndIf}
!macroend
Section
  ; How it was run, what the app's files held at the time, and whether the app was running (held its
  ; lock). (Where it ran from is not checked: this program is x86, and on ARM64 Windows its emulation
  ; keeps it locked a while after it exits.)
  FileOpen $0 "\${STATE}\\payload" r
  FileRead $0 $3
  FileClose $0
  StrCpy $7 "gone"
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "\${LOCK}") p .r8'
  \${If} $8 <> 0
    StrCpy $7 "running"
    System::Call 'kernel32::CloseHandle(p r8)'
  \${EndIf}
  FileOpen $0 "\${STATE}\\calls" a
  FileSeek $0 0 END
  FileWrite $0 "$CMDLINE|$3|$7$\\r$\\n"
  FileClose $0
  !insertmacro register arm64
  !insertmacro register x64
  FileOpen $0 "\${STATE}\\exit" r
  FileRead $0 $4
  FileClose $0
  IntOp $4 $4 + 0
  SetErrorLevel $4
SectionEnd
`);
    makensis(join(work, "runtime.nsi"), { OUT: join(work, "project/dist/runtime/vc_redist.exe"), STATE: nsisString(state), KEY: testKey, LOCK: lock }, nsis);

    // The installed app: it takes the single-instance lock, then runs for as long as its argument says;
    // opened again by the installer (no argument), it records whether it got the lock.
    writeFileSync(join(work, "app.nsi"), `Unicode true
!include FileFunc.nsh
!include LogicLib.nsh
Name "Synthetic app"
OutFile "\${OUT}"
RequestExecutionLevel user
SilentInstall silent
Section
  \${GetParameters} $0
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "\${LOCK}") p .r1 ?e'
  Pop $2
  \${If} $0 == ""
    FileOpen $3 "\${STATE}\\reopened" w
    \${If} $2 = 183
      FileWrite $3 "lost"
    \${Else}
      FileWrite $3 "kept"
    \${EndIf}
    FileClose $3
  \${Else}
    FileOpen $3 "\${STATE}\\holding" w
    FileClose $3
    Sleep $0
  \${EndIf}
SectionEnd
`);
    mkdirSync(join(state, "app"));
    makensis(join(work, "app.nsi"), { OUT: join(state, "app", appFile), STATE: nsisString(state), LOCK: lock }, nsis);

    // The step with its state in the test's key, and the app's files as one file it replaces.
    const source = readFileSync(hook, "utf8");
    expect(source.split(`HKLM "\${VOICE_RUNTIME_KEY}"`).length - 1).toBe(2);
    expect(source.split(realKey).length - 1).toBe(2);
    expect(source.split(notice).length - 1).toBe(1);
    writeFileSync(join(work, "installer.nsh"), source.replaceAll(`HKLM "\${VOICE_RUNTIME_KEY}"`, `HKCU "\${VOICE_RUNTIME_KEY}"`).replaceAll(realKey, `${testKey}\\Runtimes\\`).replace(notice, "!insertmacro recordNotice"));
    writeFileSync(join(work, "installer.nsi"), `Unicode true
!include LogicLib.nsh
Name "Runtime step"
OutFile "\${OUT}"
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails nevershow
Page instfiles
!include FileFunc.nsh
!macro recordNotice TEXT SD ANSWER
  \${IfNot} \${Silent}
    FileOpen $0 "\${STATE}\\notice" w
    FileWrite $0 "\${TEXT}"
    FileClose $0
  \${EndIf}
!macroend
; electron-builder's flags, and its StdUtils plugin's opening of a program as the signed-in user
; (recorded, then run).
!macro _isUpdated _a _b _t _f
  \${GetParameters} $R9
  ClearErrors
  \${GetOptions} $R9 "--updated" $R8
  IfErrors \`\${_f}\` \`\${_t}\`
!macroend
!define isUpdated \`"" isUpdated ""\`
!macro _isForceRun _a _b _t _f
  \${GetParameters} $R9
  ClearErrors
  \${GetOptions} $R9 "--force-run" $R8
  IfErrors \`\${_f}\` \`\${_t}\`
!macroend
!define isForceRun \`"" isForceRun ""\`
!macro recordOpen RESULT FILE VERB ARGS
  FileOpen $0 "\${STATE}\\opened" w
  FileWrite $0 "\${FILE}|\${VERB}|\${ARGS}"
  FileClose $0
  Exec '"\${FILE}" \${ARGS}'
!macroend
!define StdUtils.ExecShellAsUser "!insertmacro recordOpen"
!include "\${WORK}\\installer.nsh"
Function .onInit
  SetRegView 64
  StrCpy $INSTDIR "\${STATE}\\app"
  !insertmacro customInit
FunctionEnd
Section
  FileOpen $0 "\${STATE}\\payload" w
  FileWrite $0 "new"
  FileClose $0
  !insertmacro customInstall
SectionEnd
`);
    for (const arch of ["arm64", "x64"] as const) {
      installers[arch] = join(work, `installer-${arch}.exe`);
      makensis(join(work, "installer.nsi"), { [arch === "arm64" ? "APP_ARM64" : "APP_64"]: "1", APP_EXECUTABLE_FILENAME: appFile, PROJECT_DIR: join(work, "project"), WORK: work, STATE: nsisString(state), OUT: installers[arch] }, nsis);
    }
  }, compileTimeout);

  function clear(): void {
    for (const view of ["/reg:32", "/reg:64"]) spawnSync("reg.exe", ["delete", `HKCU\\${testKey}`, "/f", view], { stdio: "pipe" });
  }

  /** Waits, up to `runTimeout`, until `done` holds. */
  function until(done: () => boolean): void {
    const deadline = Date.now() + runTimeout;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("timed out");
      spawnSync("cmd.exe", ["/d", "/c", "ping -n 2 127.0.0.1 >nul"]);
    }
  }

  /** Ends the installed app if it still runs, and waits until Windows lets its file be written again
   *  (an x86 program stays locked a while after it exits on ARM64 Windows). */
  function stopApp(app: ChildProcess | undefined): void {
    if (app && app.exitCode === null) spawnSync("taskkill.exe", ["/F", "/PID", String(app.pid)], { stdio: "pipe" });
    until(() => {
      try {
        closeSync(openSync(join(state, "app", appFile), "r+"));
        return true;
      } catch {
        return false;
      }
    });
  }

  afterAll(() => {
    clear();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** Runs the installer for `arch`; returns its exit code, how Microsoft's installer was run (and
   *  whether the installed app was "running" then or "gone"), what the app's files hold afterwards
   *  ("old" until the installer replaces them), the notice shown, what the step opened
   *  (file|verb|arguments), and whether the app opened again "kept" the single-instance lock or
   *  "lost" it. */
  function install({ arch, before = {}, installs = {}, installsIn = 32, exit = 0, silent = true, updated = false, forceRun = false, running, readOnlyApp = false }: Scenario): { status: number | null; calls: { args: string; payload: string; app: string }[]; payload: string; notice: string; opened: string; reopened: string } {
    clear();
    for (const file of ["calls", "installs-arm64", "installs-x64", "installs-in-64", "exit", "notice", "opened", "reopened"]) rmSync(join(state, file), { force: true });
    for (const [registered, entries] of Object.entries(before)) {
      for (const { version, installed = 1, view = 32 } of [entries].flat()) {
        const key = `HKCU\\${testKey}\\Runtimes\\${registered}`;
        reg("add", key, "/v", "Installed", "/t", "REG_DWORD", "/d", String(installed), "/f", `/reg:${view}`);
        version.forEach((part, index) => {
          if (part !== undefined) reg("add", key, "/v", parts[index]!, "/t", "REG_DWORD", "/d", String(part), "/f", `/reg:${view}`);
        });
      }
    }
    if (installsIn === 64) writeFileSync(join(state, "installs-in-64"), "");
    for (const [registered, version] of Object.entries(installs)) writeFileSync(join(state, `installs-${registered}`), version.map(part => `${part}\r\n`).join(""));
    writeFileSync(join(state, "exit"), String(exit));
    writeFileSync(join(state, "payload"), "old");
    rmSync(join(state, "holding"), { force: true });
    const app = running === undefined ? undefined : spawn(join(state, "app", appFile), [String(running)], { stdio: "ignore" });
    // The app has its lock before the installer starts, as the app quitting for its update does.
    if (app) until(() => existsSync(join(state, "holding")));
    // electron-updater runs the installer with "--updated", then "/S" when silent and "--force-run"
    // for Restart Now.
    if (readOnlyApp) chmodSync(join(state, "app", appFile), 0o444);
    const run = spawnSync(installers[arch]!, [...(updated || forceRun ? ["--updated"] : []), ...(silent ? ["/S"] : []), ...(forceRun ? ["--force-run"] : [])], { stdio: "pipe", timeout: runTimeout });
    if (readOnlyApp) chmodSync(join(state, "app", appFile), 0o666);
    if (existsSync(join(state, "opened"))) until(() => existsSync(join(state, "reopened")));
    stopApp(app);
    const calls = existsSync(join(state, "calls"))
      ? readFileSync(join(state, "calls"), "utf8").split("\r\n").filter(Boolean).map(line => {
        const [command, payload, ran] = line.split("|");
        return { args: command!.slice(command!.indexOf(".exe") + ".exe".length).replace(/^"?\s*/, "").trim(), payload: payload!, app: ran! };
      })
      : [];
    const read = (file: string): string => existsSync(join(state, file)) ? readFileSync(join(state, file), "utf8") : "";
    return { status: run.status, calls, payload: readFileSync(join(state, "payload"), "utf8"), notice: read("notice"), opened: read("opened"), reopened: read("reopened") };
  }

  test.each<[string, Registered | Registered[]]>([
    ["the same version", { version: carried }],
    ["a newer revision", { version: [14, 44, 35211, 6] }],
    ["a newer build with a lower revision", { version: [14, 44, 35212, 0] }],
    ["a newer minor version with a lower build", { version: [14, 50, 100, 0] }],
    ["a newer major version with a lower minor", { version: [15, 0, 0, 0] }],
    ["the same version, in the 64-bit registry view only", { version: carried, view: 64 }],
    ["an older version in the 32-bit view and the same in the 64-bit one", [{ version: older }, { version: carried, view: 64 }]],
    ["the same version in the 32-bit view and an older in the 64-bit one", [{ version: carried }, { version: older, view: 64 }]],
  ])("with %s installed, Microsoft's installer is not run and the app is installed", (_, registered) => {
    const result = install({ arch: "arm64", before: { arm64: registered } });
    expect(result).toEqual({ status: 0, calls: [], payload: "new", notice: "", opened: "", reopened: "" });
  }, runTimeout);

  test.each<[string, Scenario["before"]]>([
    ["missing", {}],
    ["older by revision", { arm64: { version: older } }],
    ["older by build with a higher revision", { arm64: { version: [14, 44, 35210, 9] } }],
    ["older by minor version with a higher build", { arm64: { version: [14, 40, 40000, 9] } }],
    ["older by major version with a higher minor", { arm64: { version: [13, 99, 99999, 9] } }],
    ["recorded without its build and revision", { arm64: { version: [14, 44] } }],
    ["registered and not installed", { arm64: { version: carried, installed: 0 } }],
    ["installed for the other architecture only", { x64: { version: carried } }],
    ["older in both registry views", { arm64: [{ version: older }, { version: older, view: 64 }] }],
  ])("with the runtime %s, a silent install runs Microsoft's installer quietly first, then installs the app", (_, before) => {
    const result = install({ arch: "arm64", before, installs: { arm64: carried } });
    expect(result.status).toBe(0);
    expect(result.calls.map(call => [call.args, call.payload])).toEqual([["/install /quiet /norestart", "old"]]);
    expect(result.payload).toBe("new");
  }, runTimeout);

  test("an interactive install shows Microsoft's installer's progress", () => {
    const result = install({ arch: "arm64", installs: { arm64: carried }, silent: false });
    expect(result.status).toBe(0);
    expect(result.calls.map(call => [call.args, call.payload])).toEqual([["/install /passive /norestart", "old"]]);
    expect(result.payload).toBe("new");
    expect(result.notice).toBe("");
  }, runTimeout);

  test("a runtime Microsoft's installer records in the 64-bit registry view only is found", () => {
    expect(install({ arch: "arm64", installs: { arm64: carried }, installsIn: 64 })).toMatchObject({ status: 0, payload: "new" });
  }, runTimeout);

  test.each([3010, 1641])("when Microsoft's installer asks for a restart (%i), the app is installed and an interactive install says to restart", exit => {
    // Windows moves the runtime's files in use aside and puts the new ones in place, which the app
    // loads when it starts; only programs already running keep the old ones until the restart.
    const silent = install({ arch: "arm64", installs: { arm64: carried }, exit });
    expect(silent).toMatchObject({ status: 0, payload: "new", notice: "" });
    expect(silent.calls.map(call => [call.args, call.payload])).toEqual([["/install /quiet /norestart", "old"]]);
    const interactive = install({ arch: "arm64", installs: { arm64: carried }, exit, silent: false });
    expect(interactive).toMatchObject({ status: 0, payload: "new", notice: restartNotice });
    expect(interactive.calls.map(call => [call.args, call.payload])).toEqual([["/install /passive /norestart", "old"]]);
  }, runTimeout);

  test.each<[string, Pick<Scenario, "installs" | "exit">]>([
    ["refused (the administrator prompt declined)", { exit: 1602 }],
    ["reported installed without installing it", { exit: 0 }],
    ["installed only for the other architecture", { installs: { x64: carried } }],
    ["installed at an older version", { installs: { arm64: older } }],
  ])("with the runtime missing and %s, the installer exits 2 and the installed app stays as it was", (_, scenario) => {
    const result = install({ arch: "arm64", ...scenario });
    expect(result.status).toBe(2);
    expect(result.calls).toHaveLength(1);
    expect(result.payload).toBe("old");
    expect(result).toMatchObject({ opened: "", reopened: "" });
    // Restart Now quit the app for the update: it opens again, as it was, with no arguments, and
    // keeps its single-instance lock.
    const restartNow = install({ arch: "arm64", ...scenario, forceRun: true });
    expect(restartNow).toMatchObject({ status: 2, payload: "old", opened: `${join(state, "app", appFile)}|open|`, reopened: "kept" });
    expect(restartNow.calls).toHaveLength(1);
  }, runTimeout);

  test("an update waits for the app it replaces to end before Microsoft's installer runs, and before opening it again", () => {
    // The app quits for the update after starting the installer, and may take a moment to end.
    const refused = install({ arch: "arm64", exit: 1602, forceRun: true, running: 2_000 });
    expect(refused).toMatchObject({ status: 2, payload: "old", opened: `${join(state, "app", appFile)}|open|`, reopened: "kept" });
    expect(refused.calls).toEqual([{ args: "/install /quiet /norestart", payload: "old", app: "gone" }]);
    const quitTime = install({ arch: "arm64", installs: { arm64: carried }, updated: true, running: 2_000 });
    expect(quitTime).toMatchObject({ status: 0, payload: "new", opened: "", reopened: "" });
    expect(quitTime.calls).toEqual([{ args: "/install /quiet /norestart", payload: "old", app: "gone" }]);
  }, runTimeout);

  test("an update ends the app it replaces when it outlasts the wait, as electron-builder does, and an install that isn't an update doesn't wait", () => {
    const started = Date.now();
    const outlasted = install({ arch: "arm64", exit: 1602, forceRun: true, running: runTimeout });
    expect(Date.now() - started).toBeGreaterThanOrEqual(quitWait - 1_000);
    expect(outlasted).toMatchObject({ status: 2, payload: "old", opened: `${join(state, "app", appFile)}|open|`, reopened: "kept" });
    expect(outlasted.calls).toEqual([{ args: "/install /quiet /norestart", payload: "old", app: "gone" }]);
    // electron-builder asks to close a running app after this step.
    const byHandStarted = Date.now();
    const byHand = install({ arch: "arm64", installs: { arm64: carried }, running: runTimeout });
    expect(Date.now() - byHandStarted).toBeLessThan(quitWait);
    expect(byHand).toMatchObject({ status: 0, payload: "new", opened: "", reopened: "" });
    expect(byHand.calls).toEqual([{ args: "/install /quiet /norestart", payload: "old", app: "running" }]);
  }, 2 * runTimeout);

  test("an app that can't be seen to end, even after ending it, isn't opened again", () => {
    const started = Date.now();
    const result = install({ arch: "arm64", exit: 1602, forceRun: true, readOnlyApp: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * quitWait - 2_000);
    expect(result).toMatchObject({ status: 2, payload: "old", opened: "", reopened: "" });
    expect(result.calls).toHaveLength(1);
  }, 2 * runTimeout);

  test("an update Restart Now runs that installs leaves opening the app to electron-builder's installer", () => {
    expect(install({ arch: "arm64", installs: { arm64: carried }, forceRun: true })).toMatchObject({ status: 0, payload: "new", opened: "" });
    expect(install({ arch: "arm64", before: { arm64: { version: carried } }, forceRun: true })).toEqual({ status: 0, calls: [], payload: "new", notice: "", opened: "", reopened: "" });
  }, runTimeout);

  test("the runtime Windows has afterwards decides, whatever Microsoft's installer returns", () => {
    const result = install({ arch: "arm64", installs: { arm64: carried }, exit: 1602 });
    expect(result).toMatchObject({ status: 0, payload: "new" });
  }, runTimeout);

  test("the x64 installer reads and installs the x64 runtime", () => {
    expect(install({ arch: "x64", before: { x64: { version: carried } } })).toEqual({ status: 0, calls: [], payload: "new", notice: "", opened: "", reopened: "" });
    const missing = install({ arch: "x64", before: { arm64: { version: carried } }, installs: { x64: carried } });
    expect(missing.status).toBe(0);
    expect(missing.calls.map(call => call.args)).toEqual(["/install /quiet /norestart"]);
    expect(install({ arch: "x64", before: { arm64: { version: carried } }, installs: { arm64: carried } })).toMatchObject({ status: 2, payload: "old" });
  }, runTimeout);
});
