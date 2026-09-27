// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentTool } from "../core/agent/tools.js";
import * as config from "../core/config.js";
import type { DictationHotkey } from "../core/hotkey.js";
import { bubbleCentres, hintCentre, type Rect, type Size } from "../core/overlayGeometry.js";
import { type DictationTip, tipLines } from "../core/tips.js";
import type { OverlayState } from "../shared/ipc.js";
import { brandBlue, brandColour, brandGradient, grey } from "./brand.js";
import { useWindowState } from "./bridge.js";
import { ExclamationIcon, SparklesIcon, ToolIcon } from "./icons.js";
import "./overlay.css";

/**
 * The dictation overlay, anchored at the text cursor (`OverlayPanel.swift`): a swirl gathers there
 * while the microphone warms up, then forms a waveform pill, with the dictation's language in a
 * small circle left of the waveform. While it listens, a tip may show in a tooltip under it; in
 * agent mode the tools' bubbles sit in a row above it, and the running tool's border circles.
 */

type Mode =
  | { kind: "hidden" }
  | { kind: "swirl" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "running"; tool: AgentTool }
  | { kind: "message"; text: string };

function modeOf(state: OverlayState): Mode {
  const phase = state.phase;
  switch (phase.kind) {
    case "idle":
    case "arming":
      return { kind: "hidden" };
    case "listening":
      return state.isHearing ? { kind: "listening" } : { kind: "swirl" };
    case "transcribing":
      return { kind: "transcribing" };
    case "running":
      return { kind: "running", tool: phase.tool };
    case "failed":
      return { kind: "message", text: phase.message };
  }
}

const springTransition = (properties: string[]): string => properties.map((property) => `${property} ${config.pillSpringResponse}s ${config.pillSpringEasing}`).join(", ");

/** The element's laid-out size, following it as it changes. A callback ref, so an element mounted
 * after its component (a tip that appears during a hold) is measured too. */
function useSize<T extends HTMLElement>(): [React.RefCallback<T>, Size] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const ref = useCallback((element: T | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.offsetWidth, height: element.offsetHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/** Calls `frame` with the seconds since mount on every animation frame. */
function useAnimationFrame(frame: (seconds: number) => void): void {
  const latest = useRef(frame);
  latest.current = frame;
  useEffect(() => {
    const start = performance.now();
    let handle = requestAnimationFrame(function tick(now) {
      latest.current((now - start) / 1000);
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, []);
}

/** Plays `keyframes` once as the element mounts. */
function useAppear<T extends HTMLElement>(keyframes: Keyframe[], duration: number): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    // Once, as it appears.
    ref.current?.animate(keyframes, { duration, easing: config.pillSpringEasing, fill: "backwards" });
  }, []);
  return ref;
}

const appearKeyframes: Keyframe[] = [
  { transform: `scale(${config.pillAppearScale})`, opacity: 0 },
  { transform: "scale(1)", opacity: 1 },
];

function Overlay() {
  const state = useWindowState("overlay");
  const mode = state ? modeOf(state) : ({ kind: "hidden" } as const);
  // After the pill goes away, the swirl plays in reverse (spirals out and fades), mirroring how the
  // overlay appeared; the pill shrinks away meanwhile.
  const [exiting, setExiting] = useState<{ key: number; pill: Mode | null } | null>(null);
  const previous = useRef<Mode>(mode);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = mode;
    if (mode.kind === "hidden" && was.kind !== "hidden") setExiting({ key: performance.now(), pill: was.kind === "swirl" ? null : was });
    else if (mode.kind !== "hidden") setExiting(null);
  }, [mode]);

  if (!state) return null;
  const showsTools = state.mode === "agent" && (mode.kind === "listening" || mode.kind === "transcribing" || mode.kind === "running");
  const tip = mode.kind === "listening" ? state.tip : null;

  return (
    <div className="canvas" style={{ width: config.overlayCanvasSize.width, height: config.overlayCanvasSize.height }}>
      {mode.kind === "swirl" && <GatheringSwirl dispersing={false} />}
      {mode.kind === "hidden" && exiting && <GatheringSwirl key={exiting.key} dispersing />}
      {mode.kind === "hidden" && exiting?.pill && <PillLayout key={exiting.key} mode={exiting.pill} state={state} tip={null} showsTools={false} exiting />}
      {mode.kind !== "hidden" && mode.kind !== "swirl" && <PillLayout mode={mode} state={state} tip={tip} showsTools={showsTools} exiting={false} />}
    </div>
  );
}

/** Places the pill with its top edge where a one-line pill's would be when centred in the canvas, so
 * taller pills grow downward, away from the caret line; agent mode's tool bubbles go in a row above
 * it, and a tip under it (`bubbleCentres`, `hintCentre`), following it as it grows or shrinks to a
 * circle. */
function PillLayout({ mode, state, tip, showsTools, exiting }: { mode: Mode; state: OverlayState; tip: DictationTip | null; showsTools: boolean; exiting: boolean }) {
  const [pillRef, pillSize] = useSize<HTMLDivElement>();
  const canvas = config.overlayCanvasSize;
  const pill: Rect = { x: (canvas.width - pillSize.width) / 2, y: (canvas.height - config.pillHeight) / 2, ...pillSize };
  const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
  const tools = showsTools ? state.tools : [];
  const centres = bubbleCentres(pill, tools.map(() => bubble));
  const running = mode.kind === "running" ? mode.tool : null;

  const exitRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (exiting) exitRef.current?.animate([...appearKeyframes].reverse(), { duration: config.pillSpringResponse * 1000, easing: "ease-in", fill: "forwards" });
  }, [exiting]);

  return (
    <div ref={exitRef} className="layer">
      <div ref={pillRef} className="pill-anchor" style={{ top: pill.y }}>
        <Pill mode={mode} level={state.level} language={state.language} />
      </div>
      {tools.map((tool, index) => {
        const centre = centres[index];
        if (!centre) return null;
        return (
          <div key={tool} className="centred" style={{ left: centre.x, top: centre.y }}>
            <ToolBubble tool={tool} icon={tool === "thunderbird" ? state.emailAppIcon : null} isRunning={running === tool} isDimmed={running !== null && running !== tool} />
          </div>
        );
      })}
      <TipSlot tip={tip} hotkey={state.hotkey} pill={pill} />
    </div>
  );
}

function Pill({ mode, level, language }: { mode: Mode; level: number; language: string | null }) {
  const isCircle = mode.kind === "transcribing" || mode.kind === "running";
  const leadingPadding = isCircle ? 0 : mode.kind === "message" || language === null ? config.pillHorizontalPadding : config.languageBadgeInset;
  const ref = useAppear<HTMLDivElement>(appearKeyframes, config.pillSpringResponse * 1000);
  const style: CSSProperties = {
    gap: config.pillContentSpacing,
    paddingLeft: leadingPadding,
    paddingRight: isCircle ? 0 : config.pillHorizontalPadding,
    paddingTop: isCircle ? 0 : config.pillVerticalPadding,
    paddingBottom: isCircle ? 0 : config.pillVerticalPadding,
    minHeight: config.pillHeight,
    borderRadius: config.pillHeight / 2,
    borderWidth: config.pillBorderWidth,
    // A light pill in light and dark mode alike, in a gradient border.
    background: `linear-gradient(${grey(config.pillFillWhite)}, ${grey(config.pillFillWhite)}) padding-box, ${mode.kind === "transcribing" ? "transparent" : brandGradient} border-box`,
    boxShadow: `0 0 ${config.pillGlowRadius}px ${brandColour(1, config.pillGlowOpacity)}`,
    transition: springTransition(["padding"]),
  };

  // A circle is `pillHeight` across, its border inside, as SwiftUI's `strokeBorder` draws it.
  const circleContent = config.pillHeight - 2 * config.pillBorderWidth;
  let content: ReactNode;
  switch (mode.kind) {
    case "transcribing":
      // Shrinks back to a circle while the words are worked out.
      content = <div style={{ width: circleContent, height: circleContent }} />;
      break;
    case "running":
      content = (
        <div className="centre-content" style={{ width: circleContent, height: circleContent }}>
          <SparklesIcon size={config.agentRunningSymbolSize} />
        </div>
      );
      break;
    case "message":
      content = (
        <>
          <ExclamationIcon size={config.overlayFontSize} />
          <span className="message" style={{ fontSize: config.overlayFontSize, maxWidth: config.pillMaxTextWidth, WebkitLineClamp: config.pillMaxTextLines }}>
            {mode.text}
          </span>
        </>
      );
      break;
    default:
      content = (
        <>
          {language !== null && <LanguageBadge code={language} />}
          <Waveform level={level} />
        </>
      );
  }

  return (
    <div ref={ref} className="pill" style={style}>
      {content}
      {mode.kind === "transcribing" && <SpinningRim />}
    </div>
  );
}

/** The dictation's language in a small circle at the pill's left end, as its ISO code (`KO`). */
function LanguageBadge({ code }: { code: string }) {
  const diameter = config.languageBadgeDiameter;
  const label = new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;
  return (
    <div
      className="badge"
      aria-label={label}
      style={{
        width: diameter,
        height: diameter,
        borderWidth: config.pillBorderWidth,
        background: `linear-gradient(${grey(config.pillFillWhite)}, ${grey(config.pillFillWhite)}) padding-box, ${brandGradient} border-box`,
      }}
    >
      <span className="gradient-text" style={{ fontSize: config.languageBadgeFontSize, backgroundImage: brandGradient }}>
        {code.toUpperCase()}
      </span>
    </div>
  );
}

/** Voice waveform: bars follow the incoming sound level with a travelling ripple. */
function Waveform({ level }: { level: number }) {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const latestLevel = useRef(level);
  latestLevel.current = level;
  useAnimationFrame(() => {
    const time = performance.now() / 1000;
    bars.current.forEach((bar, index) => {
      if (bar) bar.style.height = `${barHeight(index, time, latestLevel.current)}px`;
    });
  });
  return (
    <div className="waveform" style={{ gap: config.overlayMeterBarSpacing, height: config.overlayMeterMaxBarHeight }}>
      {Array.from({ length: config.overlayMeterBarCount }, (_, index) => (
        <div
          key={index}
          ref={(element) => {
            bars.current[index] = element;
          }}
          className="bar"
          style={{ width: config.overlayMeterBarWidth, height: config.overlayMeterMinBarHeight, borderRadius: config.overlayMeterBarWidth / 2, backgroundImage: brandGradient }}
        />
      ))}
    </div>
  );
}

function barHeight(index: number, time: number, level: number): number {
  const count = config.overlayMeterBarCount;
  const centre = (count - 1) / 2;
  const distance = Math.abs(index - centre) / Math.max(centre, 1);
  const weight = 1 - distance * (1 - config.overlayMeterEdgeBarWeight);
  // Each bar ripples at its own speed, so the motion reads as a voice rather than a meter.
  const speed = config.waveformRippleSpeed * (1 + config.waveformSpeedVariance * Math.sin(index * 1.7));
  const ripple = (Math.sin(time * speed - index * config.waveformRipplePhase) + 1) / 2;
  // Boost quieter levels so ordinary speech moves the bars visibly, on top of an idle ripple.
  const voice = level ** config.waveformLevelExponent * config.waveformGain * weight * (1 - config.waveformRippleDepth + config.waveformRippleDepth * ripple);
  const amount = Math.min(1, config.waveformIdleLevel * ripple + voice);
  const minHeight = config.overlayMeterMinBarHeight;
  return minHeight + amount * (config.overlayMeterMaxBarHeight - minHeight);
}

/** A ring `width` thick around its box, masked out of a conic gradient. */
function ringMask(width: number): string {
  return `radial-gradient(farthest-side, transparent calc(100% - ${width}px), #000 calc(100% - ${width}px))`;
}

/** Loading indicator on the thinking circle's rim: a blue → violet arc with a fading tail, circling
 * over a faint blue ring. */
function SpinningRim() {
  const width = config.thinkingRimWidth;
  const arc = 360 * config.thinkingArcFraction;
  const ring: CSSProperties = { mask: ringMask(width) };
  return (
    <>
      <div className="rim" style={{ ...ring, background: brandColour(0, config.thinkingTrackOpacity) }} />
      <div
        className="rim spinning"
        style={{
          ...ring,
          background: `conic-gradient(${brandColour(0, 0)} 0deg, ${brandBlue} ${arc / 2}deg, ${brandColour(config.thinkingArcEndColour)} ${arc}deg, transparent ${arc}deg)`,
          animationDuration: `${1 / config.thinkingRevolutionsPerSecond}s`,
        }}
      />
    </>
  );
}

/** A bubble's border while its tool runs: a blue → violet highlight sweeping around a faint track. */
function CirclingBorder() {
  const ring: CSSProperties = { mask: ringMask(config.agentBubbleRimWidth) };
  return (
    <>
      <div className="rim" style={{ ...ring, background: brandColour(0, config.thinkingTrackOpacity) }} />
      <div
        className="rim spinning"
        style={{
          ...ring,
          background: `conic-gradient(${brandColour(0, 0)}, ${brandBlue}, ${brandColour(config.thinkingArcEndColour)}, ${brandColour(0, 0)})`,
          animationDuration: `${1 / config.agentBubbleRevolutionsPerSecond}s`,
        }}
      />
    </>
  );
}

/** One of agent mode's tools above the pill: a circle with its icon, or its app's icon when it hands
 * the request to an app. While its tool runs, it springs up larger and a gradient arc circles its
 * border; the other tools fade. */
function ToolBubble({ tool, icon, isRunning, isDimmed }: { tool: AgentTool; icon: string | null; isRunning: boolean; isDimmed: boolean }) {
  const ref = useAppear<HTMLDivElement>(appearKeyframes, config.pillSpringResponse * 1000);
  const diameter = config.agentBubbleDiameter;
  return (
    <div ref={ref}>
      <div
        className="bubble"
        aria-label={tool}
        style={{
          width: diameter,
          height: diameter,
          borderWidth: config.pillBorderWidth,
          background: `linear-gradient(${grey(config.pillFillWhite)}, ${grey(config.pillFillWhite)}) padding-box, ${isRunning ? "transparent" : brandGradient} border-box`,
          boxShadow: `0 0 ${config.pillGlowRadius}px ${brandColour(1, config.pillGlowOpacity)}`,
          transform: `scale(${isRunning ? config.agentBubbleRunningScale : 1})`,
          opacity: isDimmed ? config.agentBubbleIdleOpacity : 1,
          transition: `transform ${config.agentBubbleRunningSpringResponse}s ${config.agentBubbleRunningSpringEasing}, opacity ${config.pillSpringResponse}s ease-out`,
        }}
      >
        {icon ? <img src={icon} alt="" width={config.agentBubbleAppIconSize} height={config.agentBubbleAppIconSize} /> : <ToolIcon tool={tool} size={config.agentBubbleSymbolSize} />}
        {isRunning && <CirclingBorder />}
      </div>
    </div>
  );
}

/** The tip under the pill, fading in and out; the last one stays while it fades. */
function TipSlot({ tip, hotkey, pill }: { tip: DictationTip | null; hotkey: DictationHotkey; pill: Rect }) {
  const [shown, setShown] = useState<DictationTip | null>(tip);
  useEffect(() => {
    if (tip !== null) setShown(tip);
  }, [tip]);
  const [ref, size] = useSize<HTMLDivElement>();
  if (shown === null) return null;
  const centre = hintCentre(pill, size);
  return (
    <div
      ref={ref}
      className="centred"
      style={{ left: centre.x, top: centre.y, opacity: tip === null ? 0 : 1, transition: `opacity ${config.pillSpringResponse}s ease-out` }}
    >
      <TipTooltip tip={shown} hotkey={hotkey} />
    </div>
  );
}

/** A tip in a tooltip under the listening pill: a dark rounded box with an arrow up at the pill, the
 * tip's words around a keycap. */
function TipTooltip({ tip, hotkey }: { tip: DictationTip; hotkey: DictationHotkey }) {
  const [ref, size] = useSize<HTMLDivElement>();
  return (
    <div ref={ref} className="tip" style={{ paddingTop: config.tipArrowHeight }}>
      <svg className="tip-shape" width={size.width} height={size.height} style={{ filter: `drop-shadow(0 ${config.tipShadowOffsetY}px ${config.tipShadowRadius}px ${grey(0, config.tipShadowOpacity)})` }}>
        <path d={tooltipPath(size)} fill={grey(config.tipFillWhite, config.tipFillOpacity)} stroke={grey(1, config.tipBorderOpacity)} strokeWidth={config.pillBorderWidth} />
      </svg>
      <div
        className="tip-lines"
        style={{ gap: config.tipLineSpacing, height: config.tipHeight, padding: `${config.tipVerticalPadding}px ${config.tipHorizontalPadding}px` }}
      >
        {tipLines(tip, hotkey).map((line, index) => (
          <div key={index} className="tip-line" style={{ gap: config.tipSpacing, height: config.tipLineHeight }}>
            {line.map((part, partIndex) =>
              "words" in part ? (
                <span key={partIndex} style={{ fontSize: config.tipFontSize, color: grey(1, config.tipTextOpacity) }}>
                  {part.words}
                </span>
              ) : (
                <span
                  key={partIndex}
                  className="keycap"
                  style={{
                    fontSize: config.tipKeyFontSize,
                    color: grey(1, config.tipKeyTextOpacity),
                    padding: `0 ${config.tipKeyPadding}px`,
                    height: config.tipKeyHeight,
                    borderRadius: config.tipKeyCornerRadius,
                    borderWidth: config.pillBorderWidth,
                    borderColor: grey(1, config.tipKeyBorderOpacity),
                    background: grey(1, config.tipKeyFillOpacity),
                  }}
                >
                  {part.key}
                </span>
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A rounded box under an arrow centred on its top edge, one outline so the fill and the border run
 * around the arrow without a seam; inset half a border so the stroke stays inside. */
function tooltipPath({ width, height }: Size): string {
  const inset = config.pillBorderWidth / 2;
  const [left, right, bottom] = [inset, width - inset, height - inset];
  const top = config.tipArrowHeight + inset;
  const mid = width / 2;
  const radius = Math.max(0, Math.min(config.tipCornerRadius, (bottom - top) / 2));
  const arrow = config.tipArrowWidth / 2;
  return [
    `M ${left + radius} ${top}`,
    `L ${mid - arrow} ${top}`,
    `L ${mid} ${inset}`,
    `L ${mid + arrow} ${top}`,
    `L ${right - radius} ${top}`,
    `A ${radius} ${radius} 0 0 1 ${right} ${top + radius}`,
    `L ${right} ${bottom - radius}`,
    `A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom}`,
    `L ${left + radius} ${bottom}`,
    `A ${radius} ${radius} 0 0 1 ${left} ${bottom - radius}`,
    `L ${left} ${top + radius}`,
    `A ${radius} ${radius} 0 0 1 ${left + radius} ${top}`,
    "Z",
  ].join(" ");
}

/** Particles spiral inward to the anchor while the microphone warms up, then keep a tight orbit.
 * Dispersing plays it in reverse: out from the orbit, fading away. */
function GatheringSwirl({ dispersing }: { dispersing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width, height } = config.overlayCanvasSize;
  useAnimationFrame((elapsed) => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const progress = Math.min(1, elapsed / config.swirlGatherSeconds);
    const gathered = 1 - (1 - progress) ** 3;
    const eased = dispersing ? 1 - progress ** 3 : gathered;
    const fade = dispersing ? 1 - progress : 1;
    const radius = config.swirlStartRadius + (config.swirlOrbitRadius - config.swirlStartRadius) * eased;
    const count = config.swirlParticleCount;
    for (let index = 0; index < count; index += 1) {
      const fraction = index / count;
      const angle = 2 * Math.PI * (fraction + elapsed * config.swirlRevolutionsPerSecond);
      // Each particle trails slightly further out, so the ring reads as a spiral.
      const r = radius * (1 + fraction * config.swirlSpiralSpread);
      const dot = config.swirlParticleSize * (0.5 + 0.5 * (1 - fraction));
      context.globalAlpha = (0.35 + 0.65 * (1 - fraction)) * fade;
      context.fillStyle = brandColour(fraction);
      context.beginPath();
      context.arc(width / 2 + Math.cos(angle) * r, height / 2 + Math.sin(angle) * r, dot / 2, 0, 2 * Math.PI);
      context.fill();
    }
  });
  return <canvas ref={ref} className="swirl" width={width * window.devicePixelRatio} height={height * window.devicePixelRatio} style={{ width, height }} />;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Overlay />);
