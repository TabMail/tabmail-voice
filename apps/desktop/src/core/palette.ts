// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every color the app draws with lives here, as `#RRGGBB`, so a color is changed in one place (as
 * Thunderbird's `theme/palette/palette.data.json` and iOS's `Palette.swift`). Opacities, and how long
 * a color takes to change, are tunable numbers in `config.ts`.
 */
export const palette = {
  /** The TabMail icon's gradient, blue → purple: the overlay's pill, swirl, spinner and Settings'
   * accents. */
  brandBlue: "#0091FF",
  brandPurple: "#7B00FF",
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
  /** The Settings window's own color where macOS's frosted material is not drawn (Windows, Linux),
   * in light and dark mode. */
  settingsWindowLight: "#F4F3F8",
  settingsWindowDark: "#1F1E24",
} as const;
