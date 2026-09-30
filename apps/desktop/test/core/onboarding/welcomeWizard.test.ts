// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
import { AppSettings, suggestedUserName } from "../../../src/core/settings.js";
import { type WelcomeStep, WelcomeWizard } from "../../../src/core/onboarding/welcomeWizard.js";

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
