// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every color the app draws with lives here, so a color is changed in one place and the windows keep
 * one look (as Thunderbird's `theme/palette/palette.data.json` and iOS's `Palette.swift`): the brand
 * and the overlay's signals as `#RRGGBB`, and the windows' light and dark themes, which the
 * stylesheets read as CSS variables (`renderer/shared/theme.ts`: `controlBorder` is
 * `--control-border`). No stylesheet or component writes a color of its own. A brand color's opacity
 * where it is drawn, and how long a color takes to change, are tunable numbers in `config.ts`.
 */

/** The windows' light theme: Settings, the welcome wizard, the paste history, the screen-read
 * window, and the overlay, which is light in light and dark mode alike. */
const light = {
  /** The window's own color (on macOS Settings shows the frosted material instead). */
  window: "#F4F3F8",
  /** A group of rows: Settings' cards, the wizard's and the history's groups. */
  group: "#FFFFFF",
  separator: "rgba(0, 0, 0, 0.1)",
  text: "rgba(0, 0, 0, 0.85)",
  /** Notes and captions: 4.5:1 on the window and on a group, as small text needs. */
  secondary: "rgba(0, 0, 0, 0.6)",
  /** Buttons, links and the wizard's steps: macOS's system blue. */
  accent: "#007AFF",
  /** Text and marks on the accent and on the brand gradient. */
  onAccent: "#FFFFFF",
  /** "Allowed", and a step done: 4.5:1 on the window and on a group. */
  allowed: "#1E7E34",
  error: "#D70015",
  /** A text field's and a plain button's fill and border. */
  control: "#FFFFFF",
  controlBorder: "rgba(0, 0, 0, 0.15)",
  controlShadow: "0 0.5px 1px rgba(0, 0, 0, 0.1)",
  /** Under the pointer; the chat window's round buttons. */
  hover: "rgba(0, 0, 0, 0.06)",
  /** The chat window's question box. */
  fillSubtle: "rgba(0, 0, 0, 0.04)",
  sidebarTint: "rgba(0, 0, 0, 0.02)",
  /** An off switch's track: opaque, so its white thumb stands 3:1 from it. */
  switchOff: "#8E8E93",
  switchThumbShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
  cardShadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
};

/** The windows' theme, one color for each of `light`'s. */
export type Theme = Record<keyof typeof light, string>;

/** The windows' dark theme. */
const dark: Theme = {
  window: "#1F1E24",
  group: "#2A2A2A",
  separator: "rgba(255, 255, 255, 0.1)",
  text: "rgba(255, 255, 255, 0.85)",
  secondary: "rgba(255, 255, 255, 0.55)",
  accent: "#0A84FF",
  onAccent: "#FFFFFF",
  allowed: "#32D74B",
  error: "#FF453A",
  control: "rgba(255, 255, 255, 0.1)",
  controlBorder: "rgba(255, 255, 255, 0.15)",
  controlShadow: "0 0.5px 1px rgba(0, 0, 0, 0.1)",
  hover: "rgba(255, 255, 255, 0.07)",
  fillSubtle: "rgba(255, 255, 255, 0.04)",
  sidebarTint: "rgba(255, 255, 255, 0.02)",
  switchOff: "rgba(120, 120, 128, 0.36)",
  switchThumbShadow: "0 1px 2px rgba(0, 0, 0, 0.25)",
  cardShadow: "0 1px 2px rgba(0, 0, 0, 0.3)",
};

export const palette = {
  /** The TabMail icon's gradient, blue → purple: the overlay's pill, swirl, spinner and Settings'
   * accents. */
  brandBlue: "#0091FF",
  brandPurple: "#7B00FF",
  /** The overlay's pill, its circle and the bubbles: a soft off-white (pure white glared). */
  pillFill: "#F5F5F5",
  /** The waveform's bars: a washed-out grey-blue until a voice is heard, then a vivid iOS system
   * blue, a sign the dictation is recording (owner, 2026-10-02, chosen from a page of candidates;
   * was the brand blue, then purple, then a muted crimson). */
  waveformWaiting: "#9DB3C9",
  waveformVoiced: "#0A84FF",
  /** The thinking circle's arc while a server error is tried again, from its start to its end, and
   * its track in the start color: fuchsia, so the retry shows (owner, 2026-10-03, chosen from a page
   * of candidates; was the brand gradient moved 0.3 toward purple, too close to blue to notice). */
  retryArcStart: "#C026D3",
  retryArcEnd: "#E0399E",
  /** Agent mode's neon pill glow, a tight bright glow in a wide one: red-pink rather than the
   * brand's blue and purple, so it stands apart from dictation's pill (owner, 2026-09-29, chosen
   * from eight colors tried). */
  agentPillGlowInner: "#FF2D55",
  agentPillGlowOuter: "#FF006E",
  /** The overlay's tips and a bubble's tooltip: dark glass with white text, its keycaps a lighter
   * glass. */
  tip: {
    fill: "rgba(28, 28, 28, 0.94)",
    border: "rgba(255, 255, 255, 0.12)",
    shadow: "rgba(0, 0, 0, 0.3)",
    text: "rgba(255, 255, 255, 0.78)",
    keyText: "rgba(255, 255, 255, 0.95)",
    keyFill: "rgba(255, 255, 255, 0.14)",
    keyBorder: "rgba(255, 255, 255, 0.22)",
  },
  light,
  dark,
} as const;
