// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { deflateSync, inflateSync } from "node:zlib";
import type { Entry } from "@napi-rs/keyring";

const prefix = Buffer.from("TabMailVoiceSession\0v1\0", "ascii");
const maximumBlobBytes = 2560;
const maximumSessionBytes = 64 * 1024;
type NativeCredential = Pick<Entry, "getPassword" | "getSecret" | "setSecret" | "deletePassword">;

/** Credential Manager's blob is limited to 2560 bytes. Its password API encodes
 * UTF-16, so a normal JWT session can exceed the limit. Keep the complete JSON
 * as compressed UTF-8 binary in the same protected native credential. Writes
 * replace one item atomically; no tokens or encryption keys go into app files. */
export class WindowsSessionCredential {
  constructor(private readonly entry: NativeCredential) {}

  getPassword(): string | null {
    const bytes = this.entry.getSecret();
    if (bytes === null) return null;
    const blob = Buffer.from(bytes);
    if (!blob.subarray(0, prefix.length).equals(prefix)) {
      // Existing Windows builds stored small sessions through the UTF-16 API.
      return this.entry.getPassword();
    }
    const json = inflateSync(blob.subarray(prefix.length), { maxOutputLength: maximumSessionBytes });
    return new TextDecoder("utf-8", { fatal: true }).decode(json);
  }

  setPassword(json: string): void {
    const bytes = Buffer.from(json, "utf8");
    if (bytes.length > maximumSessionBytes) throw new Error("Session exceeds the storage bound");
    const blob = Buffer.concat([prefix, deflateSync(bytes)]);
    if (blob.length > maximumBlobBytes) throw new Error("Session exceeds the credential blob limit");
    this.entry.setSecret(blob);
  }

  deletePassword(): boolean {
    return this.entry.deletePassword();
  }
}
