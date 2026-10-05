// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../../core/config.js";
import { errorName, log } from "../../../core/log.js";
import { type RunFile, type UpdateInfo, type UpdatePlatform, type UpdateSource } from "../../updater.js";

/** `electron-updater`'s `NsisUpdater`, as far as the Windows adapter uses it. */
export interface WindowsUpdateSource extends UpdateSource {
  disableWebInstaller: boolean;
  /** Called on each downloaded installer before it is kept: null accepts it, a reason refuses it
   * (the library then deletes it and reports `ERR_UPDATER_INVALID_SIGNATURE`). */
  verifyUpdateCodeSignature: (publisherNames: string[], path: string) => Promise<string | null>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

/** What `voice-windows.exe --verify-update` says of an installer: whether Windows trusts its
 * Authenticode signature, whose it is, and the product version its signed resources carry. */
interface InstallerSignature {
  signatureValid: boolean;
  commonName: string;
  organization: string;
  productVersion: string;
}

/**
 * Windows updates (ADR-DESK-050): the signed NSIS installer from the architecture's feed. Before the
 * library keeps a download, `voice-windows.exe` asks Windows to verify its Authenticode signature
 * (the chain to a trusted root, revocation included) and reads its signed version; it is kept only
 * when signed by `windowsUpdatePublisher` and its own version is the one the feed offered, which
 * `Updater` holds newer than the running app. A feed can't so name an older signed installer as
 * newer. It installs, for this user and without an administrator, when the app quits.
 */
export function windowsUpdatePlatform(options: { source: WindowsUpdateSource; helper: string; run: RunFile }): UpdatePlatform {
  const { source, helper, run } = options;
  /** The version the feed offered: the download must be it. */
  let offered: string | null = null;
  source.disableWebInstaller = true;
  source.on("update-available", (info) => {
    offered = info.version;
  });
  source.verifyUpdateCodeSignature = async (_publisherNames, path) => {
    if (offered === null) return "no update was offered";
    try {
      const reason = refusal(await readSignature(run, helper, path), offered);
      // The library's own log is off; the reason is said here.
      if (reason !== null) log.error(`Updater: ${offered} refused: ${reason}`);
      return reason;
    } catch (error) {
      log.error(`Updater: the installer's signature couldn't be read: ${errorName(error)}`);
      return "the signature couldn't be read";
    }
  };
  return {
    source,
    installsOnQuit: true,
    // Done before the download was kept: `update-downloaded` comes only for a verified installer.
    verify: (_update: UpdateInfo) => Promise.resolve(),
    install: () => {
      // Quietly, and the new version opens once installed.
      source.quitAndInstall(true, true);
      return Promise.resolve();
    },
  };
}

async function readSignature(run: RunFile, helper: string, path: string): Promise<InstallerSignature> {
  const { code, stdout } = await run(helper, ["--verify-update", path], config.updateVerifyTimeout);
  if (code !== 0) throw new Error(`exit ${code}`);
  const reply = JSON.parse(stdout) as Partial<InstallerSignature> | null;
  if (typeof reply?.signatureValid !== "boolean" || typeof reply.commonName !== "string" || typeof reply.organization !== "string" || typeof reply.productVersion !== "string") {
    throw new Error("malformed reply");
  }
  return reply as InstallerSignature;
}

/** Why `signature` doesn't prove the installer ours and `version`, or null when it does. NSIS
 * writes the version in its four-part form, x.y.z.0. */
export function refusal(signature: InstallerSignature, version: string): string | null {
  if (!signature.signatureValid) return "Windows doesn't trust its signature";
  if (signature.commonName !== config.windowsUpdatePublisher || signature.organization !== config.windowsUpdatePublisher) return "it isn't signed by TabMail";
  if (signature.productVersion !== `${version}.0`) return "its signed version isn't the one offered";
  return null;
}
