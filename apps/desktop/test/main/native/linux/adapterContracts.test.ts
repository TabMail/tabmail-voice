// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxSystem } from '../../../../src/main/native/linux/system.js';
import type { HelperClient } from '../../../../src/main/native/helperClient.js';
import { LinuxFileStore, linuxSearchRunner } from '../../../../src/main/native/linux/files.js';
import { linuxTrayIcon } from '../../../../src/main/native/linux/trayIcon.js';
import type { NativeImage } from 'electron';
const electron = vi.hoisted(() => ({ openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }));
vi.mock('electron', () => ({ shell: electron, nativeImage: { createFromBitmap: (bitmap: Buffer, size: unknown) => ({ bitmap, size }) } }));
test('a native foreground token reaches the dictation caller', async () => {
  const request = vi.fn(async () => ({ window: 42 })); const system = new LinuxSystem({ request } as unknown as HelperClient);
  expect(await system.frontmostApp()).toBe(42); expect(request).toHaveBeenCalledExactlyOnceWith('frontmostApp');
});
test('search results cross the actual child-process protocol', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabmail-file-wire-'));
  try {
    const exe = join(dir, 'synthetic-helper');
    await writeFile(exe, `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const input=JSON.parse(line);if(input.words[0]!=='synthetic')process.exit(9);process.stdout.write(JSON.stringify([['file:///tmp/synthetic.pdf','Synthetic',null,'application/pdf']])+'\\n');rl.close();});\n`, { mode: 0o700 });
    expect(await linuxSearchRunner(exe)({ words: ['synthetic'] })).toEqual([['file:///tmp/synthetic.pdf', 'Synthetic', null, 'application/pdf']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('unsupported files are revealed while ordinary documents open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabmail-open-policy-')); electron.openPath.mockClear(); electron.showItemInFolder.mockClear();
  try {
    const pdf = join(dir, 'document.pdf'), unknown = join(dir, 'command.sh'); await writeFile(pdf, 'synthetic', { mode: 0o600 }); await writeFile(unknown, 'synthetic', { mode: 0o600 });
    // macOS /tmp is a symlink; use the canonical path so this checks file type, not ancestor refusal.
    const { realpath } = await import('node:fs/promises'); const store = new LinuxFileStore(await realpath(dir), async () => []);
    expect(await store.open(await realpath(pdf), false)).toBe(true);
    expect(await store.open(await realpath(unknown), false)).toBe(false);
    expect(electron.openPath).toHaveBeenCalledTimes(1); expect(electron.showItemInFolder).toHaveBeenCalledExactlyOnceWith(await realpath(unknown));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('the Linux glyph stays visible and preserves its transparent background', () => {
  const template = { toBitmap: () => Buffer.from([0, 0, 0, 255, 0, 0, 0, 0]), getSize: () => ({ width: 2, height: 1 }) } as unknown as NativeImage;
  const result = linuxTrayIcon(template, true) as unknown as { bitmap: Buffer };
  expect([...result.bitmap.subarray(0, 4)]).toEqual([255, 255, 255, 255]); expect(result.bitmap[7]).toBe(0);
});

test.each([['eng', 'en'], ['kor', 'ko'], ['zh_CN', 'zh'], ['en-US', 'en'], ['yue', null], ['', null], ['not a language', null], [null, null]])('keyboard language %s reaches the shared badge as %s', async (code, expected) => {
  const request = vi.fn(async () => ({ code }));
  const system = new LinuxSystem({ request } as unknown as HelperClient);
  expect(await system.keyboardLanguage()).toBe(expected);
  expect(request).toHaveBeenCalledExactlyOnceWith('keyboardLanguage');
});
