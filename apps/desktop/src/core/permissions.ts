// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
import { Observable } from "./observable.js";

/** Electron's `systemPreferences.getMediaAccessStatus` values. */
export type MicrophoneStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** How the grants are read and asked for; tests pass their own. */
export interface PermissionSystem {
  readMicrophone(): MicrophoneStatus;
  readAccessibility(): boolean;
  /** Shows the system's microphone prompt. */
  askForMicrophone(): Promise<void>;
  /** Shows the system's Accessibility prompt; true when already granted. */
  askForAccessibility(): boolean;
  /** Opens the system's privacy settings at the named pane. */
  openSettings(pane: "microphone" | "accessibility"): void;
}

/** The two grants dictation needs: Microphone (to hear) and Accessibility (to see the hotkey
 * system-wide and to paste into other apps). */
export class PermissionsModel extends Observable {
  private microphoneStatus: MicrophoneStatus;
  private trusted: boolean;
  private poll: ReturnType<typeof setInterval> | null = null;

  /** Fires once when Accessibility flips to granted, so the hotkey monitor can be re-installed. */
  onAccessibilityGranted: (() => void) | undefined;
  /** Fires once when Microphone flips to granted (the model already reports it). */
  onMicrophoneGranted: (() => void) | undefined;

  constructor(
    private readonly system: PermissionSystem,
    private readonly pollInterval: number = config.accessibilityPollInterval,
  ) {
    super();
    this.microphoneStatus = system.readMicrophone();
    this.trusted = system.readAccessibility();
  }

  get microphone(): MicrophoneStatus {
    return this.microphoneStatus;
  }

  get accessibilityTrusted(): boolean {
    return this.trusted;
  }

  get allGranted(): boolean {
    return this.microphoneStatus === "granted" && this.trusted;
  }

  refresh(): void {
    const wasMicrophone = this.microphoneStatus;
    const wasTrusted = this.trusted;
    this.microphoneStatus = this.system.readMicrophone();
    this.trusted = this.system.readAccessibility();
    if (this.microphoneStatus !== wasMicrophone || this.trusted !== wasTrusted) this.changed();
    if (this.microphoneStatus === "granted" && wasMicrophone !== "granted") this.onMicrophoneGranted?.();
    if (this.trusted && !wasTrusted) this.onAccessibilityGranted?.();
  }

  async requestMicrophone(): Promise<void> {
    const status = this.system.readMicrophone();
    if (status === "not-determined") await this.system.askForMicrophone();
    else if (status === "denied" || status === "restricted") this.system.openSettings("microphone");
    this.refresh();
  }

  /** Shows the system Accessibility prompt, then watches for the grant in System Settings. */
  requestAccessibility(): void {
    if (!this.system.askForAccessibility()) this.system.openSettings("accessibility");
    this.startPollingAccessibility();
  }

  startPollingAccessibility(): void {
    if (this.trusted || this.poll !== null) return;
    this.poll = setInterval(() => {
      this.refresh();
      if (this.trusted) this.stopPolling();
    }, this.pollInterval);
  }

  stopPolling(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
  }
}
