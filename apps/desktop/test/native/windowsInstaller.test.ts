// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The installer's Visual C++ runtime step (ADR-DESK-057), compiled by the NSIS electron-builder
// packages with and run for real on Windows. Microsoft's installer is replaced by a synthetic one
// with the same version resource, which records how it was run and writes the runtime state a run
// asks for; that state lives in a key of this test's own under the current user, which is the one
// change made to resources/windows/installer.nsh before compiling it (where Windows keeps the real
// state is pinned in packaging.test.ts).

const desktop = resolve(__dirname, "../..");
const hook = join(desktop, "resources/windows/installer.nsh");
const realKey = "SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\";
const testKey = `Software\\TabMailVoiceTest\\${randomUUID()}`;
// Compiling may first download electron-builder's NSIS, and each run starts two programs.
const compileTimeout = 300_000;
const runTimeout = 60_000;

type Arch = "arm64" | "x64";
type Version = [major: number, minor: number];
/** A runtime registered as installed (or, with `installed: 0`, registered and not installed). */
type Registered = { version: Version; installed?: 0 | 1 };
type Scenario = {
  arch: Arch;
  before?: Partial<Record<Arch, Registered>>;
  /** What the synthetic Microsoft installer registers, and the exit code it returns. */
  installs?: Partial<Record<Arch, Version>>;
  exit?: number;
  silent?: boolean;
};

const nsisString = (value: string): string => value.replaceAll("$", "$$");

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

    // Microsoft's installer, as far as the step can tell: its version resource is 14.44.
    mkdirSync(join(work, "project/dist/runtime"), { recursive: true });
    writeFileSync(join(work, "runtime.nsi"), `Unicode true
Name "Synthetic runtime"
OutFile "\${OUT}"
RequestExecutionLevel user
SilentInstall silent
VIProductVersion "14.44.35211.0"
VIAddVersionKey "ProductName" "Synthetic runtime"
VIAddVersionKey "FileVersion" "14.44.35211.0"
VIAddVersionKey "FileDescription" "Synthetic runtime"
VIAddVersionKey "LegalCopyright" "TabMail"
!macro register ARCH
  IfFileExists "\${STATE}\\installs-\${ARCH}" 0 +9
    FileOpen $0 "\${STATE}\\installs-\${ARCH}" r
    FileRead $0 $1
    FileRead $0 $2
    FileClose $0
    IntOp $1 $1 + 0
    IntOp $2 $2 + 0
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Installed" 1
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Major" $1
    WriteRegDWORD HKCU "\${KEY}\\Runtimes\\\${ARCH}" "Minor" $2
!macroend
Section
  ; How it was run, and what the app's files held at the time. (Where it ran from is not checked:
  ; this program is x86, and on ARM64 Windows its emulation keeps it locked a while after it exits.)
  FileOpen $0 "\${STATE}\\payload" r
  FileRead $0 $3
  FileClose $0
  FileOpen $0 "\${STATE}\\calls" a
  FileSeek $0 0 END
  FileWrite $0 "$CMDLINE|$3$\\r$\\n"
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
    makensis(join(work, "runtime.nsi"), { OUT: join(work, "project/dist/runtime/vc_redist.exe"), STATE: nsisString(state), KEY: testKey }, nsis);

    // The step with its state in the test's key, and the app's files as one file it replaces.
    const source = readFileSync(hook, "utf8");
    expect(source.split(`HKLM "\${VOICE_RUNTIME_KEY}"`).length - 1).toBe(3);
    expect(source.split(realKey).length - 1).toBe(2);
    writeFileSync(join(work, "installer.nsh"), source.replaceAll(`HKLM "\${VOICE_RUNTIME_KEY}"`, `HKCU "\${VOICE_RUNTIME_KEY}"`).replaceAll(realKey, `${testKey}\\Runtimes\\`));
    writeFileSync(join(work, "installer.nsi"), `Unicode true
!include LogicLib.nsh
Name "Runtime step"
OutFile "\${OUT}"
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails nevershow
Page instfiles
!include "\${WORK}\\installer.nsh"
Function .onInit
  SetRegView 64
  !insertmacro customInit
FunctionEnd
Section
  FileOpen $0 "\${STATE}\\payload" w
  FileWrite $0 "new"
  FileClose $0
SectionEnd
`);
    for (const arch of ["arm64", "x64"] as const) {
      installers[arch] = join(work, `installer-${arch}.exe`);
      makensis(join(work, "installer.nsi"), { [arch === "arm64" ? "APP_ARM64" : "APP_64"]: "1", PROJECT_DIR: join(work, "project"), WORK: work, STATE: nsisString(state), OUT: installers[arch] }, nsis);
    }
  }, compileTimeout);

  afterAll(() => {
    spawnSync("reg.exe", ["delete", `HKCU\\${testKey}`, "/f"], { stdio: "pipe" });
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** Runs the installer for `arch`; returns its exit code, how Microsoft's installer was run, and
   *  what the app's files hold afterwards ("old" until the installer replaces them). */
  function install({ arch, before = {}, installs = {}, exit = 0, silent = true }: Scenario): { status: number | null; calls: { args: string; payload: string }[]; payload: string } {
    spawnSync("reg.exe", ["delete", `HKCU\\${testKey}`, "/f"], { stdio: "pipe" });
    for (const file of ["calls", "installs-arm64", "installs-x64", "exit"]) rmSync(join(state, file), { force: true });
    for (const [registered, { version, installed = 1 }] of Object.entries(before)) {
      const key = `HKCU\\${testKey}\\Runtimes\\${registered}`;
      reg("add", key, "/v", "Installed", "/t", "REG_DWORD", "/d", String(installed), "/f");
      reg("add", key, "/v", "Major", "/t", "REG_DWORD", "/d", String(version[0]), "/f");
      reg("add", key, "/v", "Minor", "/t", "REG_DWORD", "/d", String(version[1]), "/f");
    }
    for (const [registered, version] of Object.entries(installs)) writeFileSync(join(state, `installs-${registered}`), `${version[0]}\r\n${version[1]}\r\n`);
    writeFileSync(join(state, "exit"), String(exit));
    writeFileSync(join(state, "payload"), "old");
    const run = spawnSync(installers[arch]!, silent ? ["/S"] : [], { stdio: "pipe", timeout: runTimeout });
    const calls = existsSync(join(state, "calls"))
      ? readFileSync(join(state, "calls"), "utf8").split("\r\n").filter(Boolean).map(line => {
        const [command, payload] = line.split("|");
        return { args: command!.slice(command!.indexOf(".exe") + ".exe".length).replace(/^"?\s*/, "").trim(), payload: payload! };
      })
      : [];
    return { status: run.status, calls, payload: readFileSync(join(state, "payload"), "utf8") };
  }

  test.each<[string, Registered]>([
    ["the same version", { version: [14, 44] }],
    ["a newer minor version", { version: [14, 50] }],
    ["a newer major version with a lower minor", { version: [15, 0] }],
  ])("with %s installed, Microsoft's installer is not run and the app is installed", (_, registered) => {
    const result = install({ arch: "arm64", before: { arm64: registered } });
    expect(result).toEqual({ status: 0, calls: [], payload: "new" });
  }, runTimeout);

  test.each<[string, Scenario["before"]]>([
    ["missing", {}],
    ["older by minor version", { arm64: { version: [14, 40] } }],
    ["older by major version with a higher minor", { arm64: { version: [13, 99] } }],
    ["registered and not installed", { arm64: { version: [14, 44], installed: 0 } }],
    ["installed for the other architecture only", { x64: { version: [14, 44] } }],
  ])("with the runtime %s, a silent install runs Microsoft's installer quietly first, then installs the app", (_, before) => {
    const result = install({ arch: "arm64", before, installs: { arm64: [14, 44] } });
    expect(result.status).toBe(0);
    expect(result.calls.map(call => [call.args, call.payload])).toEqual([["/install /quiet /norestart", "old"]]);
    expect(result.payload).toBe("new");
  }, runTimeout);

  test("an interactive install shows Microsoft's installer's progress", () => {
    const result = install({ arch: "arm64", installs: { arm64: [14, 44] }, silent: false });
    expect(result.status).toBe(0);
    expect(result.calls.map(call => [call.args, call.payload])).toEqual([["/install /passive /norestart", "old"]]);
    expect(result.payload).toBe("new");
  }, runTimeout);

  test("a restart Microsoft's installer asks for does not stop the app's install", () => {
    const result = install({ arch: "arm64", installs: { arm64: [14, 44] }, exit: 3010 });
    expect(result).toMatchObject({ status: 0, payload: "new" });
    expect(result.calls).toHaveLength(1);
  }, runTimeout);

  test.each<[string, Pick<Scenario, "installs" | "exit">]>([
    ["refused (the administrator prompt declined)", { exit: 1602 }],
    ["reported installed without installing it", { exit: 0 }],
    ["installed only for the other architecture", { installs: { x64: [14, 44] } }],
    ["installed at an older version", { installs: { arm64: [14, 40] } }],
  ])("with the runtime missing and %s, the installer exits 2 and the installed app stays as it was", (_, scenario) => {
    const result = install({ arch: "arm64", ...scenario });
    expect(result.status).toBe(2);
    expect(result.calls).toHaveLength(1);
    expect(result.payload).toBe("old");
  }, runTimeout);

  test("the runtime Windows has afterwards decides, whatever Microsoft's installer returns", () => {
    const result = install({ arch: "arm64", installs: { arm64: [14, 44] }, exit: 1602 });
    expect(result).toMatchObject({ status: 0, payload: "new" });
  }, runTimeout);

  test("the x64 installer reads and installs the x64 runtime", () => {
    expect(install({ arch: "x64", before: { x64: { version: [14, 44] } } })).toEqual({ status: 0, calls: [], payload: "new" });
    const missing = install({ arch: "x64", before: { arm64: { version: [14, 44] } }, installs: { x64: [14, 44] } });
    expect(missing.status).toBe(0);
    expect(missing.calls.map(call => call.args)).toEqual(["/install /quiet /norestart"]);
    expect(install({ arch: "x64", before: { arm64: { version: [14, 44] } }, installs: { arm64: [14, 44] } })).toMatchObject({ status: 2, payload: "old" });
  }, runTimeout);
});
