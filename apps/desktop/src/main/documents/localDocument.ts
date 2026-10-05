// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { documentMaxBytes, documentReadChunkBytes } from "../../core/config.js";
import { CancellationError } from "../../core/util/timeout.js";

const refusal = () => new Error("Only unchanged regular local files in your home folder can be read (maximum 20 MiB).");

/** Lexical validation also applies to canonical paths, so a Windows junction cannot
 * redirect a local drive path to a network share or an alternate data stream. */
export function localDocumentPath(given: string, home: string, windows: boolean): string {
  if (Array.from(given).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw refusal();
  const relativeHome = given === "~" || given.startsWith("~/") || (windows && given.startsWith("~\\"));
  const expanded = relativeHome ? home + given.slice(1) : given;
  if (!windows) {
    if (!expanded.startsWith("/") || expanded.startsWith("//")) throw refusal();
    return posix.normalize(expanded);
  }
  const path = expanded.replaceAll("/", "\\");
  if (!/^[a-z]:\\[^<>:"|?*]*$/iu.test(path)) throw refusal();
  // Win32 strips trailing dots/spaces and interprets reserved device basenames.
  if (path.slice(3).split("\\").some((part) => part !== "." && part !== ".." &&
    (/[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)))) throw refusal();
  return win32.normalize(path);
}

function inside(path: string, home: string): boolean {
  const api = process.platform === "win32" ? win32 : posix;
  const relative = api.relative(home, path);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function canceled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancellationError();
}

/** Metadata-only preparation. Display `path` in the explicit read confirmation,
 * then call read only after approval. No descriptor is held while waiting. */
export class LocalDocument {
  private constructor(readonly path: string, private readonly home: string, private readonly identity: BigIntStats) {}

  static async prepare(given: string, home: string, signal: AbortSignal): Promise<LocalDocument> {
    try {
      canceled(signal);
      const windows = process.platform === "win32";
      const realHome = await realpath(home);
      const path = await realpath(localDocumentPath(given, home, windows));
      localDocumentPath(path, realHome, windows);
      if (!inside(path, realHome)) throw refusal();
      const identity = await stat(path, { bigint: true });
      if (!identity.isFile() || identity.size > BigInt(documentMaxBytes)) throw refusal();
      canceled(signal);
      return new LocalDocument(path, realHome, identity);
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      throw refusal();
    }
  }

  async read(signal: AbortSignal): Promise<Uint8Array> {
    try {
      canceled(signal);
      const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const file = await open(this.path, flags);
      try {
        const currentPath = await realpath(this.path);
        localDocumentPath(currentPath, this.home, process.platform === "win32");
        if (currentPath !== this.path || !inside(currentPath, this.home)) throw refusal();
        const before = await file.stat({ bigint: true });
        if (!unchanged(this.identity, before) || !unchanged(before, await stat(currentPath, { bigint: true }))) throw refusal();
        canceled(signal);
        // Read the validated descriptor, never reopen the path. The fixed allocation
        // prevents a concurrently growing file from exhausting memory.
        const bytes = new Uint8Array(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          canceled(signal);
          const result = await file.read(bytes, offset, Math.min(documentReadChunkBytes, bytes.length - offset), offset);
          if (result.bytesRead === 0) throw refusal();
          offset += result.bytesRead;
        }
        if (!unchanged(before, await file.stat({ bigint: true }))) throw refusal();
        canceled(signal);
        return bytes;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof CancellationError) throw error;
      throw refusal();
    }
  }
}
