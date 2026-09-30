// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/core/config.js";
import { MemoryStore } from "../src/core/keyValueStore.js";
import { type MicrophoneStatus, PermissionsModel, type PermissionSystem } from "../src/core/permissions.js";
import { AppSettings, suggestedUserName } from "../src/core/settings.js";
import { type DictationTip, TipBook, tipDetails } from "../src/core/tips.js";
import { type WelcomeStep, WelcomeWizard } from "../src/core/welcomeWizard.js";

function settings(store = new MemoryStore()): AppSettings {
  return new AppSettings(store, () => false);
}

describe("WelcomeWizard", () => {
  /** Consent, then the user's name, then the two permissions, then the features, under four rail
   * categories; Back walks them in reverse. */
  test("steps run consent, then the name, then permissions, then features", () => {
    expect(WelcomeWizard.categories.map((category) => category.label)).toEqual(["Consent", "About You", "Permissions", "Features"]);
    expect(WelcomeWizard.steps).toEqual(["consent", "name", "microphone", "accessibility", "screenReading"]);

    const app = settings();
    app.hasConsented = true;
    const wizard = new WelcomeWizard(app, () => "");
    const categories = [wizard.categoryIndex];
    while (!wizard.isLastStep) {
      wizard.next();
      categories.push(wizard.categoryIndex);
    }
    expect(categories).toEqual([0, 1, 2, 2, 3]);

    // Back retraces the same steps one at a time.
    const steps: WelcomeStep[] = [];
    while (!wizard.isFirstStep) {
      wizard.back();
      steps.push(wizard.step);
    }
    expect(steps).toEqual(["accessibility", "microphone", "name", "consent"]);
  });

  /** No step after consent is reachable until the user agrees; withdrawing it blocks again. */
  test("consent comes before everything else", () => {
    const app = settings();
    const wizard = new WelcomeWizard(app, () => "");

    expect(wizard.canAdvance).toBe(false);
    wizard.next();
    wizard.goTo(1);
    expect(wizard.step).toBe("consent");

    app.hasConsented = true;
    expect(wizard.canAdvance).toBe(true);
    wizard.next();
    expect(wizard.step).toBe("name");

    wizard.back();
    app.hasConsented = false;
    wizard.next();
    expect(wizard.step).toBe("consent");
  });

  /** The name, permissions and features never block Next: they can be set or changed later. */
  test("name, permission and feature steps can be skipped", () => {
    const app = settings();
    app.hasConsented = true;
    const wizard = new WelcomeWizard(app, () => "");
    wizard.next();
    for (const step of ["name", "microphone", "accessibility", "screenReading"] as const) {
      expect(wizard.step).toBe(step);
      expect(wizard.canAdvance).toBe(true);
      if (step !== "screenReading") wizard.next();
    }
  });

  /** Like the Thunderbird rail: a bubble goes back to a step already reached, never ahead. */
  test("rail bubbles only go back", () => {
    const app = settings();
    app.hasConsented = true;
    const wizard = new WelcomeWizard(app, () => "");
    wizard.next();
    wizard.next();
    expect(wizard.index).toBe(2);

    wizard.goTo(3);
    expect(wizard.index).toBe(2);
    wizard.goTo(-1);
    expect(wizard.index).toBe(2);
    wizard.goTo(1.5);
    expect(wizard.index).toBe(2);
    wizard.goTo(2);
    expect(wizard.index).toBe(2);
    wizard.goTo(0);
    expect(wizard.index).toBe(0);
    expect(wizard.isFirstStep).toBe(true);
    wizard.back();
    expect(wizard.index).toBe(0);
  });

  /** Finish is on the last step only; it records the wizard as done (so it stops opening at
   * launch) and closes it, once. */
  test("finishing records the wizard as done", () => {
    const store = new MemoryStore();
    const app = settings(store);
    app.hasConsented = true;
    const wizard = new WelcomeWizard(app, () => "");
    let finishes = 0;
    wizard.onFinish = () => {
      finishes += 1;
    };

    while (!wizard.isLastStep) {
      wizard.next();
      expect(app.hasFinishedWelcome).toBe(false);
      expect(finishes).toBe(0);
    }
    wizard.next();
    expect(app.hasFinishedWelcome).toBe(true);
    expect(finishes).toBe(1);
    expect(wizard.step).toBe("screenReading");
    expect(settings(store).hasFinishedWelcome).toBe(true);
  });
});

describe("the user's name", () => {
  /** The name step offers the computer account's name (owner, 2026-09-28): Next without editing it
   * keeps that; a name typed, or one cleared, stays as the user left it. */
  test("the name step keeps the offered name unless the user changed it", () => {
    const offered = (userName: string | null): string | null => {
      const app = settings();
      app.hasConsented = true;
      if (userName !== null) app.userName = userName;
      const wizard = new WelcomeWizard(app, () => "Alex Example");
      wizard.next();
      expect(wizard.step).toBe("name");
      wizard.next();
      expect(wizard.step).toBe("microphone");
      return app.userName;
    };
    expect(offered(null)).toBe("Alex Example");
    expect(offered("Sam")).toBe("Sam");
    expect(offered("")).toBe("");
  });

  /** Only the name step's Next stores the offered name: consent's, a later step's and Finish don't. */
  test("no other step stores the offered name", () => {
    const app = settings();
    const wizard = new WelcomeWizard(app, () => "Alex Example");
    app.hasConsented = true;
    wizard.next();
    expect(app.userName).toBeNull();
    wizard.next();
    app.userName = null;
    while (!wizard.isLastStep) wizard.next();
    wizard.next();
    expect(app.hasFinishedWelcome).toBe(true);
    expect(app.userName).toBeNull();
  });

  /** Stored as typed, kept across launches; agent mode sends it trimmed, and nothing when blank. */
  test("the name is stored as typed and sent trimmed", () => {
    const store = new MemoryStore();
    const app = settings(store);
    expect(app.userName).toBeNull();
    expect(app.dictation(null).userName).toBe("");
    app.userName = "  Alex Example ";
    expect(settings(store).userName).toBe("  Alex Example ");
    expect(app.dictation(null).userName).toBe("Alex Example");
    app.userName = "   ";
    expect(app.dictation(null).userName).toBe("");
    app.userName = null;
    expect(settings(store).userName).toBeNull();
  });

  /** The full name of the computer account, else its short name. */
  test("the offered name is the account's full name, else its short name", () => {
    expect(suggestedUserName(" Alex Example ", "alex")).toBe("Alex Example");
    expect(suggestedUserName("", "alex")).toBe("alex");
    expect(suggestedUserName("  ", " alex ")).toBe("alex");
  });
});

describe("TipBook", () => {
  test.each<DictationTip>(["switchMode", "doubleTap"])("%s shows at most its max displays", (tip) => {
    const store = new MemoryStore();
    const tips = new TipBook(store);
    const maxDisplays = tipDetails[tip].maxDisplays;
    expect(maxDisplays).not.toBeNull();
    for (let index = 0; index < (maxDisplays ?? 0); index += 1) {
      expect(tips.isEligible(tip)).toBe(true);
      tips.recordDisplay(tip);
    }
    expect(tips.isEligible(tip)).toBe(false);
    // Kept across launches.
    expect(new TipBook(store).isEligible(tip)).toBe(false);
  });

  /** A tip configured with no maximum shows however often it has shown: the hands-free tip, and the
   * name tip until a name is set (owner, 2026-09-28: a nag). */
  test.each<DictationTip>(["handsFree", "setName"])("%s has no maximum and shows every time", (tip) => {
    expect(tipDetails[tip].maxDisplays).toBeNull();
    const tips = new TipBook(new MemoryStore());
    for (let index = 0; index < 100; index += 1) tips.recordDisplay(tip);
    expect(tips.isEligible(tip)).toBe(true);
  });

  test("a learned tip never shows again, and learning one leaves the other", () => {
    const store = new MemoryStore();
    new TipBook(store).markLearned("switchMode");

    const tips = new TipBook(store);
    expect(tips.isEligible("switchMode")).toBe(false);
    expect(tips.isEligible("doubleTap")).toBe(true);
  });

  test("the tips' words, limits and durations come from the config", () => {
    expect(tipDetails).toEqual({ switchMode: config.switchModeTip, doubleTap: config.doubleTapTip, handsFree: config.handsFreeTip, setName: config.setNameTip });
  });
});

describe("PermissionsModel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function system(state: { microphone: MicrophoneStatus; trusted: boolean }): PermissionSystem & { opened: string[]; asked: number } {
    return {
      opened: [],
      asked: 0,
      readMicrophone: () => state.microphone,
      readAccessibility: () => state.trusted,
      async askForMicrophone() {
        this.asked += 1;
        state.microphone = "granted";
      },
      askForAccessibility: () => state.trusted,
      openSettings(pane) {
        this.opened.push(pane);
      },
    };
  }

  /** Each grant is announced once, as it lands, not again at later refreshes. */
  test("announces each grant once when it lands", () => {
    const state = { microphone: "not-determined" as MicrophoneStatus, trusted: false };
    const permissions = new PermissionsModel(system(state));
    const heard: string[] = [];
    permissions.onMicrophoneGranted = () => heard.push("microphone");
    permissions.onAccessibilityGranted = () => heard.push("accessibility");

    permissions.refresh();
    state.microphone = "granted";
    permissions.refresh();
    permissions.refresh();
    state.trusted = true;
    permissions.refresh();
    permissions.refresh();

    expect(heard).toEqual(["microphone", "accessibility"]);
    expect(permissions.allGranted).toBe(true);

    // Revoked and granted again: announced again.
    state.microphone = "denied";
    permissions.refresh();
    state.microphone = "granted";
    permissions.refresh();
    expect(heard).toEqual(["microphone", "accessibility", "microphone"]);
  });

  /** Denied and undecided grants are kept as read, as well as granted ones. */
  test.each<[MicrophoneStatus, boolean]>([
    ["not-determined", false],
    ["restricted", true],
    ["denied", false],
    ["granted", false],
    ["granted", true],
  ])("starts with the states read from the system (%s, %s)", (microphone, trusted) => {
    const permissions = new PermissionsModel(system({ microphone, trusted }));
    expect(permissions.microphone).toBe(microphone);
    expect(permissions.accessibilityTrusted).toBe(trusted);
  });

  test("asking for the microphone prompts once, then sends a refusal to System Settings", async () => {
    const state = { microphone: "not-determined" as MicrophoneStatus, trusted: true };
    const fake = system(state);
    const permissions = new PermissionsModel(fake);

    await permissions.requestMicrophone();
    expect([fake.asked, permissions.microphone]).toEqual([1, "granted"]);

    state.microphone = "denied";
    await permissions.requestMicrophone();
    expect(fake.asked).toBe(1);
    expect(fake.opened).toEqual(["microphone"]);
  });

  /** The Accessibility grant happens in System Settings: the model watches for it, and stops
   * watching once it lands. */
  test("watches for the Accessibility grant until it lands", () => {
    vi.useFakeTimers();
    const state = { microphone: "granted" as MicrophoneStatus, trusted: false };
    const fake = system(state);
    const permissions = new PermissionsModel(fake, 1_000);
    let granted = 0;
    permissions.onAccessibilityGranted = () => {
      granted += 1;
    };

    permissions.requestAccessibility();
    expect(fake.opened).toEqual(["accessibility"]);
    vi.advanceTimersByTime(3_000);
    expect(granted).toBe(0);
    state.trusted = true;
    vi.advanceTimersByTime(1_000);
    expect(granted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
