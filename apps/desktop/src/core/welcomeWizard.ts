// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Observable } from "./observable.js";
import type { AppSettings } from "./settings.js";

export type WelcomeStep = "consent" | "microphone" | "accessibility" | "screenReading";

export interface WelcomeCategory {
  label: string;
  steps: WelcomeStep[];
}

/** First-run setup, laid out like the Thunderbird welcome wizard: steps grouped under categories in
 * a top rail, Back and Next below, Finish on the last step. Consent comes first and must be given
 * before any other step; permissions and features can be skipped and changed later. */
export class WelcomeWizard extends Observable {
  static readonly categories: readonly WelcomeCategory[] = [
    { label: "Consent", steps: ["consent"] },
    { label: "Permissions", steps: ["microphone", "accessibility"] },
    { label: "Features", steps: ["screenReading"] },
  ];
  static readonly steps: readonly WelcomeStep[] = WelcomeWizard.categories.flatMap((category) => category.steps);

  private current = 0;
  /** Called once Finish is pressed on the last step. */
  onFinish: (() => void) | undefined;

  constructor(private readonly settings: AppSettings) {
    super();
  }

  get index(): number {
    return this.current;
  }

  get step(): WelcomeStep {
    return WelcomeWizard.steps[this.current] ?? "consent";
  }

  get categoryIndex(): number {
    return Math.max(0, WelcomeWizard.categories.findIndex((category) => category.steps.includes(this.step)));
  }

  get isFirstStep(): boolean {
    return this.current === 0;
  }

  get isLastStep(): boolean {
    return this.current === WelcomeWizard.steps.length - 1;
  }

  /** Next (or Finish) is available once this step allows it: only consent has a requirement. */
  get canAdvance(): boolean {
    return this.step !== "consent" || this.settings.hasConsented;
  }

  next(): void {
    if (!this.canAdvance) return;
    if (this.isLastStep) {
      this.settings.hasFinishedWelcome = true;
      this.onFinish?.();
    } else {
      this.move(this.current + 1);
    }
  }

  back(): void {
    if (this.isFirstStep) return;
    this.move(this.current - 1);
  }

  /** A rail bubble returns to a step already reached, never skips ahead (as in Thunderbird). */
  goTo(target: number): void {
    if (!Number.isInteger(target) || target < 0 || target > this.current) return;
    this.move(target);
  }

  private move(index: number): void {
    this.current = index;
    this.changed();
  }
}
