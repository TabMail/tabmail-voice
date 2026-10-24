## ADR-DESK-048: Every color in one palette file; one time for every color change

**Context:** Owner, 2026-10-03: the retry's shift toward purple on the thinking circle
(ADR-DESK-039) did not show; from a page of candidates the owner chose fuchsia, asked that it fade
in "just like the voice" (the waveform's 0.4 s ease, ADR-DESK-006's 2026-10-02 amendment), with "the
transition time … a variable configured globally", and asked for "a palette file for both the iOS
and the Voice app, similarly to Thunderbird, so that we can actually adjust the colors easily from
the palette". Colors were spread across `config.ts` (the waveform's, agent mode's glow, the Settings
window's) and `renderer/shared/brand.ts` (the brand blue and purple).

**Decision:**
- **`src/core/palette.ts`** holds every named color the app draws with, as `#RRGGBB`: the brand
  blue and purple, the waveform's waiting and recording colors, the retry's arc colors, agent mode's
  glow, and the Settings window's own colors. `brand.ts` reads the brand colors from it, and its
  `rgba(hex, alpha)` takes a palette color. Opacities and the color change's time stay tunable
  numbers in `config.ts`. As Thunderbird's `theme/palette/palette.data.json` and iOS's
  `Theme/Palette.swift` (ADR-IOS-085's 2026-10-03 amendment).
- **`colorTransitionSeconds`** (0.4 s, renamed from `waveformColorTransitionSeconds`) is how long
  every color change in the overlay eases: the waveform's, and the thinking circle's.
- **The retry's colors fade.** The thinking circle draws its two sets of colors as two layers
  (`RimLayer`) circling together, the brand's and the retry's (`palette.retryArcStart` #C026D3 →
  `palette.retryArcEnd` #E0399E, the track in the start color), one fading out as the other fades in
  over `colorTransitionSeconds`, since a CSS gradient can't ease from one color to another.
  `thinkingRetryColorShift` is gone.
- **One theme for every window** (owner, same day: "include the gray and shadows into the palette
  and unify it so that there's a single sort of a palette theme"). The palette's `light` and `dark`
  themes hold the windows' grays, text, accent, control fills, borders and shadows;
  `renderer/shared/theme.ts` gives each page them as CSS variables (`controlBorder` is
  `--control-border`) in one constructed stylesheet (`applyPalette`, before the page renders), since
  the pages' Content Security Policy (`style-src 'self'`) refuses a `<style>` element. Settings, the
  welcome wizard, the paste history and the screen-read window follow the system's light and dark;
  the overlay keeps the light theme in both, as it did. The stylesheets declare no colors of their
  own (a Windows contrast theme's system colors aside), and the overlay's tips (`palette.tip`) and
  pill fill (`palette.pillFill`) left `config.ts`'s gray levels and opacities.
- Unifying settled the values the windows had disagreed on: the window color is Settings'
  `#F4F3F8` / `#1F1E24` everywhere (the wizard and history were `#ececec` / `#1e1e1e`), and the
  notes gray (0.6) and "Allowed" green (`#1E7E34`) Settings darkened in light mode for 4.5:1 apply
  to every window. The overlay's chat window took the light theme's values too: its text and Cancel
  0.85 black (was black), its caption and close glyph the notes gray (0.6, were 0.55 and 0.5), and its
  spinner's ring the control border (0.15, was 0.2).

**Consequences:**
- A color is changed in `palette.ts` alone; `theme.test.ts` fails on a color written in any
  stylesheet or component (the brand's `brand.ts` helpers and a ring's opaque mask aside), and on a
  variable a stylesheet reads that nothing gives.
- The wizard's and history's background is a touch lighter and cooler than before; their notes and
  "Allowed" a touch darker in light mode.
- The thinking circle draws two arcs at once; the hidden one is fully transparent.
- Tests: `overlay/index.test.ts` › the waveform takes its recording colour once a voice is heard, and
  the circle the retry's colours while a retry runs (red-verified against a retry layer never shown
  and against no fade). The `overlay-transcribing-retry` preview shows the retry's circle.
  `shared/theme.test.ts` (no color outside the palette, every variable given, windows follow light
  and dark while the overlay stays light; red-verified against a color written in a stylesheet and
  in a component, a variable nothing gives, and the overlay given the dark theme), and
  `settings/style.test.ts`'s contrast checks, which now read the palette's themes.


> **Amended (owner, 2026-10-09): one glass for every floating surface, and the overlay follows light
> and dark.** From pages of candidates (the not-pasted note's look, then the whole theme on one page
> with light, dark and a slider), the owner chose a minimal, rounder glass after macOS 26's: *"no
> gradients"*, *"it should still have our glow"*, the rim *"should be hairline"*, *"for the dark glass,
> I think we should obey the theme of the system"*, the glass 97% opaque (first 95%, then 97%, so *"only subtle things showing up in the back"*), its
> shadow crisp as a Mac window's (the soft one left the edge *"slightly too soft"*), and *"consistency is
> king"*: what the owner had already chosen (the pill's size and glow, the waveform's colors, the
> fuchsia retry, agent mode's red-pink glow, the pale-blue request) stays. So:
> - **The glass** is the palette's, in its light and dark themes: `glass` (`overlayGlassOpacity`,
>   0.97), `glassHighlight` and `glassEdge` (the light on its top edge, its inner hairline), `rim` (a
>   hairline a breath of the brand's blue-purple, in place of the gradient border), `glow` (the brand's
>   purple), and `contact` and `ambient`, the crisp shadow: a tight contact shadow at the edge, which
>   gives it a defined border, under a wide, faint ambient one (`glassShadow`; `chatShadowMargin` and
>   `pasteHistoryShadowMargin` leave room for its `glassShadowReach`). `renderer/shared/glass.ts`'s `glassStyle` composes
>   them, with `config`'s widths and radii, for every surface: the pill and its circle, the bubbles and
>   their tooltip, messages, the not-pasted note, the tips, the chat window, and the paste history.
>   Agent mode's pill keeps its red-pink glow in the brand glow's place. A surface's border stays
>   transparent over the fill, so no size changed.
> - **No blur, the same on every platform.** The overlay is one transparent window larger than what it
>   draws: a native blur (macOS's vibrancy, Windows 11's materials; Linux has none) would fill all of
>   it, and CSS can't blur what is behind a window. The paste history leaves its macOS popover
>   material for the same glass, in a transparent window `pasteHistoryShadowMargin` larger on each
>   side for its glow; its page's `:root` outranks `form.css`'s `html, body`, which the build links
>   after it (as Settings' does).
> - **The overlay follows the system's light and dark**, as the windows do: `applyPalette` has no
>   light-only form left, and the overlay's colors are all the theme's variables. The tips leave their
>   dark HUD (`palette.tip`, gone) for the glass, with its rim and glow; their keycaps a faint fill.
> - **No gradients in what is drawn on the glass.** The language badge is a ring and letters in the
>   accent; every line icon (tools, apps, agent mode's sparkles, a failure's mark) is one color, the
>   theme's accent (`AccentIcon`, was `GradientIcon`; owner: the tool icons *"should be a single
>   color"*); the not-pasted note's clipboard is the caption's gray. A countdown (the chat's, its
>   question's, the note's) is a faint `countdown` hairline inset from its surface's sides by their
>   corner's radius, never a full-width gradient bar. The thinking circle's arc and the running
>   bubble's keep their blue-to-violet and fuchsia, as chosen (this ADR).
> - **Rounder**: the chat window and the note 20 (were 14 and 12), what sits inside them 12, a tip 12.
> - Unchanged: Settings and the welcome wizard (ordinary windows), whose brand-gradient accents (the
>   chosen section, the wizard's buttons) are the owner's call.
>   *Then (owner, the same day, from real renders of Settings in three accents):* Settings' switches
>   and its default button ("Email Me a Code") are the flat accent, as the welcome wizard's already
>   were (`form.css`'s `button.default`; `--brand-gradient` gone); the chosen section keeps the brand
>   gradient (*"the tab color that we had with the brand gradient is actually better"*). The welcome
>   wizard is unchanged. Test: `settings/style.test.ts` (only the chosen section on the gradient, the
>   switch on the accent, no button of Settings' own; red-verified).
>
> Tests: `shared/theme.test.ts` (every page, the overlay too, takes the light and the dark theme),
> `shared/icons.test.tsx` (every tool, app and status icon one accent color, no gradient;
> red-verified against the gradient icons), `overlay/index.test.ts` (the pill and the chat window are
> the theme's glass with its rim, the chat's glow the theme's; the note's Copy; the countdowns),
> `history/index.test.ts` (the card is the glass with its glow; the page stays clear above
> `form.css`), `main/index.test.ts` and `main/windows.test.ts` (the history's window is its card's
> place grown by the margin, transparent without the system's shadow), `overlayGeometry.test.ts` (a
> tip's glow inside the canvas). The preview renders the overlay in dark too (`…-dark`).

