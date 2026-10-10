// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type AgentChat, type ChatTurn, formattedReply, remainingFraction, replyBlocks, revealSteps } from "../../core/agent/chat.js";
import { type BubbleKey, bubbleName, bubbleOrder } from "../../core/agent/bubbleOrder.js";
import { connectorByID, isConnectorID } from "../../core/agent/connectors/index.js";
import { type AgentToolID, agentTools } from "../../core/agent/tools.js";
import * as config from "../../core/config.js";
import { palette } from "../../core/palette.js";
import type { DictationHotkey } from "../../core/hotkey/bindings.js";
import { bubbleRow, bubbleRowOpacity, bubbleTooltipCenter, grownBubble, hintCenter, hintCenterOver, type Point, type Rect, type Size, tipGoesAbove, underBubbles } from "../../core/ui/overlayGeometry.js";
import { type DictationTip, tipDetails, tipLines } from "../../core/onboarding/tips.js";
import type { ChatPlacement, OverlayState } from "../../shared/ipc.js";
import { brandBlue, brandColor, brandGradient, rgba } from "../shared/brand.js";
import { send, useWindowState } from "../shared/bridge.js";
import { ClipboardIcon, ConnectorIcon, CopyIcon, ExclamationIcon, SparklesIcon, ToolIcon } from "../shared/icons.js";
import { applyPalette } from "../shared/theme.js";
import "./index.css";

/**
 * The dictation overlay, anchored at the text cursor (`OverlayPanel.swift`): a swirl gathers there
 * while the microphone warms up, then forms a waveform pill, with the dictation's language in a
 * small circle left of the waveform. While it listens, a tip may show in a tooltip under it (Space
 * switches agent mode and a double tap dictates without holding, each fading after a moment; how
 * hands-free listening ends, up while it listens, over the pill when the overlay opened above the
 * caret's line); in agent mode a bubble for each tool and each app Answer reaches sits in a row
 * under it, the one that ran last first; only the one running now, first in the row, circles, enlarged. Once agent mode
 * answers, the chat window (`ChatBox`) opens over the pill, which rests there as a small circle
 * between follow-ups.
 */

type Mode =
  | { kind: "hidden" }
  | { kind: "swirl" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "running"; tool: AgentToolID | null }
  | { kind: "message"; text: string }
  /** The text was not pasted: a card with the message beside a clipboard and an x that dismisses it,
   * over a box showing the text with a copy sign, which copies it when clicked anywhere, and a bar
   * along its bottom showing the time left. */
  | { kind: "notPasted"; message: string; text: string }
  /** A server error, while the transcription is tried again: the note alone, no warning sign. */
  | { kind: "retrying"; text: string }
  /** Under the open chat window while nothing runs. */
  | { kind: "resting" };

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
    case "retrying":
      return { kind: "retrying", text: phase.message };
    case "running":
      return { kind: "running", tool: phase.tool };
    case "failed":
      return { kind: "message", text: phase.message };
    case "notPasted":
      return { kind: "notPasted", message: phase.message, text: phase.text };
  }
}

const springTransition = (properties: string[]): string => properties.map((property) => `${property} ${config.pillSpringResponseSeconds}s ${config.pillSpringEasing}`).join(", ");

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

const fadeKeyframes: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

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
  // The warm-up swirl fades out as what follows it appears, still circling; each new one gathers
  // afresh.
  const [swirl, setSwirl] = useState<{ key: number; leaving: boolean } | null>(null);
  const swirlGone = useRef<ReturnType<typeof setTimeout>>(undefined);
  const previous = useRef<Mode>(mode);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = mode;
    if (mode.kind === "hidden" && was.kind !== "hidden") setExiting({ key: performance.now(), pill: was.kind === "swirl" ? null : was });
    else if (mode.kind !== "hidden") setExiting(null);
    if (mode.kind === "swirl" && was.kind !== "swirl") {
      clearTimeout(swirlGone.current);
      setSwirl({ key: performance.now(), leaving: false });
    } else if (mode.kind !== "swirl" && was.kind === "swirl") {
      setSwirl((current) => current && { ...current, leaving: true });
      swirlGone.current = setTimeout(() => setSwirl(null), config.pillSpringResponseSeconds * 1000);
    }
  }, [mode]);

  if (!state) return null;
  const placement = state.chat === null ? null : state.chatPlacement;
  const chat = placement === null ? null : state.chat;
  const canvas = config.overlayCanvasSize;
  // The one-line pill's top edge, centered in the canvas: taller pills grow downward.
  let anchor: Point = { x: canvas.width / 2, y: (canvas.height - config.pillHeight) / 2 };
  let layer: { size: Size; style?: CSSProperties } = { size: canvas };
  let pillMode: Mode | null = mode.kind === "hidden" || mode.kind === "swirl" ? null : mode;
  let showsTools = state.mode === "agent" && (mode.kind === "listening" || mode.kind === "transcribing" || mode.kind === "retrying" || mode.kind === "running");
  if (placement !== null) {
    // Under the chat window, a follow-up's pill listens from the start, rests while nothing runs, and
    // keeps its bubbles.
    ({ anchor, ...layer } = chatPillLayer(placement));
    pillMode = mode.kind === "hidden" ? { kind: "resting" } : mode.kind === "swirl" ? { kind: "listening" } : mode;
    showsTools = true;
  }
  const tip = mode.kind === "listening" && chat === null ? state.tip : null;

  // One tree with the chat window open or not, so the pill and its bubbles stay as they were as it
  // opens.
  return (
    <div className={chat === null ? "canvas" : "canvas chat-canvas"} style={chat === null ? { width: canvas.width, height: canvas.height } : undefined}>
      {chat === null && swirl && <GatheringSwirl key={`swirl-${swirl.key}`} dispersing={false} leaving={swirl.leaving} />}
      {chat === null && mode.kind === "hidden" && exiting && <GatheringSwirl key={`dispersing-${exiting.key}`} dispersing />}
      {chat === null && mode.kind === "hidden" && exiting?.pill && (
        <PillLayout key={`exiting-${exiting.key}`} mode={exiting.pill} state={state} tip={null} showsTools={false} keepsBubbles={false} exiting anchor={anchor} canvas={canvas} bubblesUnder={state.bubblesFitUnder} />
      )}
      {chat !== null && placement !== null && <ChatBox chat={chat} below={placement.below} maxHeight={placement.maxHeight} width={placement.width ?? config.chatWidth} />}
      {pillMode !== null && (
        <PillLayout mode={pillMode} state={state} tip={tip} showsTools={showsTools} keepsBubbles={chat !== null} exiting={false} anchor={anchor} canvas={layer.size} bubblesUnder={placement?.bubblesUnder ?? state.bubblesFitUnder} layerStyle={layer.style} />
      )}
    </div>
  );
}

/** Where the pill and its bubbles go beside the chat window: a strip along the window's edge on the
 * pill's side (its bottom edge, with the chat over the pill), which the window keeps fixed as the chat
 * grows, so the pill never moves; with room over the pill for a hovered bubble's tooltip. The pill
 * sits under its bubbles when they go over it (`bubblesUnder`). */
function chatPillLayer(placement: ChatPlacement): { anchor: Point; size: Size; style: CSSProperties } {
  const margin = config.chatShadowMargin;
  const height = config.chatBubbleTooltipRoom + config.chatStripHeight + margin;
  const size = { width: (placement.width ?? config.chatWidth) + 2 * margin, height };
  const overBubbles = placement.bubblesUnder ? 0 : config.agentBubbleGap + config.agentBubbleDiameter;
  if (placement.below) return { anchor: { x: placement.pillX, y: margin + overBubbles }, size, style: { inset: "auto", left: 0, right: 0, top: 0, height } };
  return { anchor: { x: placement.pillX, y: config.chatBubbleTooltipRoom + overBubbles }, size, style: { inset: "auto", left: 0, right: 0, bottom: 0, height } };
}

/** A bubble in the row under the pill. */
interface BubbleItem {
  key: BubbleKey;
  name: string;
  description: string;
  isRunning: boolean;
  isDimmed: boolean;
  opacity: number;
  icon: ReactNode;
}

/** Places the pill with its top edge's center at `anchor`, taller pills growing downward, away from
 * the caret line; agent mode's bubbles in a row under it (over it when they don't fit under it,
 * `bubbleRow`), the ones that ran last first (`bubbleOrder`), the first few in full and the rest fading
 * away to the right; and a tip under it and the bubbles, or over it all when `tipGoesAbove`
 * (`hintCenter`, `hintCenterOver`), following it as it grows or shrinks to a circle. With the chat
 * window open (`keepsBubbles`), the bubbles of the last request stay while a follow-up works out its
 * own. */
function PillLayout({
  mode,
  state,
  tip,
  showsTools,
  keepsBubbles,
  exiting,
  anchor,
  canvas,
  bubblesUnder,
  layerStyle,
}: {
  mode: Mode;
  state: OverlayState;
  tip: DictationTip | null;
  showsTools: boolean;
  keepsBubbles: boolean;
  exiting: boolean;
  anchor: Point;
  canvas: Size;
  bubblesUnder: boolean;
  layerStyle?: CSSProperties;
}) {
  const [pillRef, pillSize] = useSize<HTMLDivElement>();
  const pill: Rect = { x: anchor.x - pillSize.width / 2, y: anchor.y, ...pillSize };
  const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
  const kept = useRef<BubbleKey[]>([]);
  let shown: BubbleKey[] = showsTools ? [...state.tools, ...state.connectors] : [];
  if (keepsBubbles && shown.length === 0) shown = kept.current;
  else kept.current = shown;
  // One bubble runs at a time, the first in the row: the app whose tool runs, else the tool agent mode
  // answers or writes with; none while it thinks.
  const isRunning = (key: BubbleKey) => key === state.runningBubble;
  const anyRunning = state.runningBubble !== null;
  const bubbles: BubbleItem[] = bubbleOrder(shown, state.recentBubbles)
    .map((key, index) => ({
      key,
      name: bubbleName(key),
      description: isConnectorID(key) ? connectorByID[key].settingsDescription : agentTools[key].settingsDescription,
      isRunning: isRunning(key),
      isDimmed: anyRunning && !isRunning(key),
      opacity: bubbleRowOpacity(index),
      icon: isConnectorID(key) ? (
        <ConnectorIcon connector={key} size={config.agentBubbleSymbolSize} />
      ) : key === "thunderbird" && state.emailAppIcon ? (
        <img src={state.emailAppIcon} alt="" width={config.agentBubbleAppIconSize} height={config.agentBubbleAppIconSize} />
      ) : (
        <ToolIcon tool={key} size={config.agentBubbleSymbolSize} />
      ),
    }))
    .filter((item) => item.opacity > 0);
  const centers = bubbleRow(pill, bubbles.length, bubblesUnder);
  const frames = centers.map((center) => ({ x: center.x - bubble.width / 2, y: center.y - bubble.height / 2, ...bubble }));
  // The bubble under the pointer, by name.
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredIndex = bubbles.findIndex((item) => item.key === hovered);
  // One that goes (Space back to dictation) takes its hover with it: an unmounted bubble hears no
  // pointer leave, and back later it is not under the pointer.
  if (hovered !== null && hoveredIndex < 0) setHovered(null);
  const hoveredBubble = bubbles[hoveredIndex];
  const hoveredFrame = frames[hoveredIndex];

  const exitRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (exiting) exitRef.current?.animate([...appearKeyframes].reverse(), { duration: config.pillSpringResponseSeconds * 1000, easing: "ease-in", fill: "forwards" });
  }, [exiting]);

  return (
    <div ref={exitRef} className="layer" style={layerStyle}>
      <div ref={pillRef} className="pill-anchor" style={{ left: anchor.x, top: anchor.y }}>
        <Pill mode={mode} level={state.level} hasVoice={state.hasVoice} isRetrying={state.isRetrying} language={state.language} isAgent={state.mode === "agent" || keepsBubbles} maxWidth={canvas.width - 2 * config.pillGlowReach} />
      </div>
      {bubbles.map((item, index) => {
        const center = centers[index];
        if (!center) return null;
        const move = `${config.agentBubbleMoveDurationSeconds}s ${config.pillSpringEasing}`;
        return (
          // Keyed by bubble, so one that moves along the row as another runs slides there.
          <div key={item.key} className="centered" style={{ left: center.x, top: center.y, transition: `left ${move}, top ${move}` }}>
            <Bubble
              label={item.key}
              isRunning={item.isRunning}
              isDimmed={item.isDimmed}
              opacity={item.opacity}
              isHovered={hovered === item.key}
              onHover={(isHovered) => setHovered(isHovered ? item.key : null)}
            >
              {item.icon}
            </Bubble>
          </div>
        );
      })}
      <TipSlot gnomeRecordingKeys={state.gnomeRecordingKeys === true} tip={tip} hotkey={state.hotkey} pill={pill} bubbles={frames} opensUpward={state.opensUpward} />
      {hoveredBubble && hoveredFrame && (
        // Keyed by bubble, so the next bubble's tooltip is measured afresh (hidden until then), not
        // shown at the last one's size.
        <BubbleTooltip
          key={hoveredBubble.key}
          name={hoveredBubble.name}
          description={hoveredBubble.description}
          bubble={grownBubble(hoveredFrame, hoveredBubble.isRunning ? config.agentBubbleRunningScale : config.agentBubbleHoverScale)}
          canvas={canvas}
        />
      )}
    </div>
  );
}

/** The chat window over the pill once agent mode answers (owner, 2026-09-28: it "appears smoothly
 * above in a subtle way, and then it just keeps on showing the answers"): each request and its reply,
 * revealed as TabMail's chat in Thunderbird reveals one (`RevealedReply`), what is being worked on, a
 * close button, and, while untouched, a bar along the bottom edge that shrinks from right to left as
 * its time runs out (like the iOS app's `PendingSendToast`). The pointer entering or moving in it, a
 * click or a scroll keeps it open (`keepChatOpen`); Escape or the close button closes it. It grows to
 * what it shows over `chatGrowDurationSeconds`, its edge by the pill staying put, in the overlay
 * window at its tallest; it reports that height, the part of the window that takes clicks, and the
 * pointer moving over it or off it (`ChatHitTest`). Under the pill's bubbles instead when there is no
 * room over it (`below`). Light in light and dark mode alike, as the pill. */
function ChatBox({ chat, below, maxHeight, width }: { chat: AgentChat; below: boolean; maxHeight: number; width: number }) {
  const [sizeRef, contentSize] = useSize<HTMLDivElement>();
  const appearRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the newest line is in view: a line revealed then keeps it there, but not once the user
  // has scrolled up to read an earlier answer.
  const atBottom = useRef(true);
  const contentRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      return sizeRef(element);
    },
    [sizeRef],
  );
  // Its scrolling column's height, and its border: until measured, as tall as that lays out.
  const height = contentSize.height > 0 ? contentSize.height + 2 * config.pillBorderWidth : undefined;
  useLayoutEffect(() => {
    // Once, as it opens: rising from the pill a little as it fades in.
    const rise = below ? -config.chatAppearRise : config.chatAppearRise;
    appearRef.current?.animate(
      [
        { opacity: 0, transform: `translateY(${rise}px) scale(${config.chatAppearScale})` },
        { opacity: 1, transform: "none" },
      ],
      { duration: config.chatAppearDurationSeconds * 1000, easing: "ease-out", fill: "backwards" },
    );
  }, []);
  useEffect(() => {
    if (height !== undefined) void send({ type: "chatHeight", height });
  }, [height]);
  useEffect(() => {
    // Over the chat or the pill's bubbles, or not. Each move says so: the window may have been placed
    // afresh meanwhile, letting clicks through until told.
    const moved = (event: PointerEvent) => void send({ type: "pointerOver", over: event.target instanceof Element && event.target.closest(".chat, .bubble") !== null });
    const left = () => void send({ type: "pointerOver", over: false });
    document.addEventListener("pointermove", moved);
    document.documentElement.addEventListener("pointerleave", left);
    return () => {
      document.removeEventListener("pointermove", moved);
      document.documentElement.removeEventListener("pointerleave", left);
    };
  }, []);
  const status = chat.activity ?? (chat.pendingRequest !== null && chat.confirmation === null ? config.chatThinkingLabel : null);
  const toBottom = useCallback(() => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    atBottom.current = true;
  }, []);
  // The newest turn, what is being worked on, or the tool's question in view: only when one of them
  // changes, since every state push (a follow-up's level, many times a second) brings a new copy of
  // the same chat, and the user may have scrolled up to read an earlier answer.
  useLayoutEffect(toBottom, [chat.turns.length, chat.pendingRequest, status, chat.confirmation, toBottom]);
  const revealed = useCallback(() => {
    if (atBottom.current) toBottom();
  }, [toBottom]);
  const touch = () => {
    if (!chat.touched) void send({ type: "keepChatOpen" });
  };
  const margin = config.chatShadowMargin;
  const offset = margin + config.chatStripHeight + config.chatPillGap;
  return (
    <div
      ref={appearRef}
      className="chat"
      onPointerEnter={touch}
      onPointerMove={touch}
      onPointerDown={touch}
      onWheel={touch}
      style={{
        left: margin,
        ...(below ? { top: offset } : { bottom: offset }),
        transformOrigin: below ? "top center" : "bottom center",
        width,
        height,
        transition: `height ${config.chatGrowDurationSeconds}s ease-out`,
        borderRadius: config.chatCornerRadius,
        borderWidth: config.pillBorderWidth,
        background: `linear-gradient(${palette.pillFill}, ${palette.pillFill}) padding-box, ${brandGradient} border-box`,
        boxShadow: `0 0 ${config.pillGlowRadius}px ${brandColor(1, config.pillGlowOpacity)}`,
      }}
    >
      <div
        ref={contentRef}
        className="chat-scroll"
        onScroll={(event) => {
          const scroll = event.currentTarget;
          atBottom.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= config.chatFontSize * 2;
        }}
        style={{ maxHeight, gap: config.chatTurnSpacing, padding: config.chatPadding, paddingTop: config.chatPadding + config.chatCloseButtonSize }}
      >
        {chat.turns.map((turn) => (
          <div key={turn.id} className="chat-turn" style={{ gap: config.chatTurnSpacing }}>
            <RequestBubble text={turn.request} />
            <Reply turn={turn} onReveal={revealed} />
          </div>
        ))}
        {chat.pendingRequest !== null && <RequestBubble text={chat.pendingRequest} />}
        {status !== null && <Activity label={status} />}
        {chat.confirmation !== null && <ConfirmationCard question={chat.confirmation} expiresAt={chat.confirmationExpiresAt} />}
      </div>
      {chat.closesAt !== null && <TimeoutBar closesAt={chat.closesAt} timeout={config.chatTimeout} />}
      <button
        type="button"
        className="chat-close"
        aria-label="Close"
        onClick={() => void send({ type: "closeChat" })}
        style={{ width: config.chatCloseButtonSize, height: config.chatCloseButtonSize, top: config.chatBubblePadding, right: config.chatBubblePadding, fontSize: config.chatCaptionFontSize }}
      >
        ✕
      </button>
    </div>
  );
}

/** What a tool the answer's model called is doing, beside a spinner, while it runs. */
function Activity({ label }: { label: string }) {
  const size = config.chatCaptionFontSize;
  return (
    <div className="chat-caption chat-activity" style={{ fontSize: size, gap: config.chatBubblePadding / 2 }}>
      <div
        className="chat-spinner spinning"
        style={{ width: size, height: size, borderWidth: config.chatActivitySpinnerLineWidth, animationDuration: `${1 / config.chatActivitySpinnerRevolutionsPerSecond}s` }}
      />
      {label}
    </div>
  );
}

/** What a tool asks before it sends or creates anything: it runs only on Confirm, and a bar along its
 * bottom edge shows the time left to answer. */
function ConfirmationCard({ question, expiresAt }: { question: string; expiresAt: number | null }) {
  const button = (title: string, confirmed: boolean) => (
    <button
      type="button"
      className={confirmed ? "chat-confirm" : "chat-cancel"}
      onClick={() => void send({ type: "answerConfirmation", confirmed })}
      style={{
        fontSize: config.chatCaptionFontSize,
        padding: `${config.chatBubblePadding / 2}px ${config.chatBubblePadding}px`,
        ...(confirmed ? { background: brandBlue } : {}),
      }}
    >
      {title}
    </button>
  );
  return (
    <div className="chat-confirmation" style={{ gap: config.chatBubblePadding, padding: config.chatBubblePadding, borderRadius: config.chatBubbleCornerRadius }}>
      <div className="chat-text" style={{ fontSize: config.chatFontSize }}>
        {question}
      </div>
      <div className="chat-confirmation-buttons" style={{ gap: config.chatBubblePadding }}>
        {button("Cancel", false)}
        {button("Confirm", true)}
      </div>
      {expiresAt !== null && <TimeoutBar closesAt={expiresAt} timeout={config.chatConfirmationTimeout} />}
    </div>
  );
}

/** The user's words on the right, laid out as Thunderbird's chat shows them, in one flat pale blue
 * with a hairline border (`palette.chatRequestFill`). */
function RequestBubble({ text }: { text: string }) {
  return (
    <div
      className="chat-request"
      style={{
        fontSize: config.chatFontSize,
        lineHeight: config.chatLineHeight,
        padding: `${config.chatBubblePadding}px ${config.chatBubblePadding + 2}px`,
        borderRadius: config.chatBubbleCornerRadius,
        maxWidth: config.chatWidth * config.chatRequestMaxWidthFraction,
        background: palette.chatRequestFill,
        border: `${config.pillBorderWidth}px solid ${palette.chatRequestBorder}`,
      }}
    >
      {text}
    </div>
  );
}

/** The reply: the answer, or what another tool wrote under what it did with it. */
function Reply({ turn, onReveal }: { turn: ChatTurn; onReveal: () => void }) {
  const caption = agentTools[turn.tool].chatCaption;
  return (
    <div className="chat-reply" style={{ gap: config.chatBubblePadding / 2 }}>
      {caption !== null && (
        <div className="chat-caption" style={{ fontSize: config.chatCaptionFontSize, gap: config.chatBubblePadding / 2 }}>
          <ToolIcon tool={turn.tool} size={config.chatCaptionFontSize} />
          {caption}
        </div>
      )}
      <div className="chat-text" style={{ fontSize: config.chatFontSize, lineHeight: config.chatLineHeight }}>
        <RevealedReply reply={turn.reply} onReveal={onReveal} />
      </div>
    </div>
  );
}

/** A reply as TabMail's chat in Thunderbird shows one (`setBubbleText`): laid out in blocks
 * (`replyBlocks`) and revealed a line or list item at a time, `chatRevealStepInterval` apart, each
 * fading in as it rises (`.reveal`). `onReveal` hears of each. The first shows at once. */
function RevealedReply({ reply, onReveal }: { reply: string; onReveal: () => void }) {
  const blocks = replyBlocks(reply);
  const steps = revealSteps(blocks);
  const [shown, setShown] = useState(1);
  useEffect(() => {
    if (shown >= steps) return;
    const timer = setTimeout(() => setShown((count) => count + 1), config.chatRevealStepInterval);
    return () => clearTimeout(timer);
  }, [shown, steps]);
  useLayoutEffect(onReveal, [shown, onReveal]);
  const reveal: CSSProperties = { animationDuration: `${config.chatRevealFadeDuration}ms`, ["--reveal-rise" as string]: `${config.chatRevealRise}px` };
  let step = 0;
  /** The next step's element, or nothing while it is still to come. */
  const next = (content: (style: CSSProperties) => ReactNode): ReactNode => (step++ < shown ? content(reveal) : null);
  return (
    <>
      {blocks.map((block, index) => {
        const spacing: CSSProperties = index === 0 ? {} : { marginTop: config.chatParagraphSpacing };
        switch (block.kind) {
          case "paragraph":
            return (
              <div key={index} className="chat-paragraph" style={spacing}>
                {block.lines.map((line, lineIndex) =>
                  next((style) => (
                    <div key={lineIndex} className="reveal" style={style}>
                      <FormattedLine text={line} />
                    </div>
                  )),
                )}
              </div>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) =>
              next((style) => (
                <li key={itemIndex} className="reveal" style={style}>
                  <FormattedLine text={item} />
                </li>
              )),
            );
            const listStyle: CSSProperties = { ...spacing, paddingLeft: config.chatListIndent };
            return block.ordered ? (
              <ol key={index} className="chat-list" start={block.start} style={listStyle}>
                {items}
              </ol>
            ) : (
              <ul key={index} className="chat-list" style={listStyle}>
                {items}
              </ul>
            );
          }
          case "heading":
            return next((style) => (
              <div key={index} className="chat-heading reveal" style={{ ...spacing, ...style }}>
                <FormattedLine text={block.text} />
              </div>
            ));
        }
      })}
    </>
  );
}

/** A line's inline Markdown (`formattedReply`); its web links open in the browser, through the main
 * process, which checks them again. */
function FormattedLine({ text }: { text: string }) {
  return (
    <>
      {formattedReply(text).map((run, index) => {
        let content: ReactNode = run.text;
        if (run.code) content = <code>{content}</code>;
        if (run.strong) content = <strong>{content}</strong>;
        if (run.emphasis) content = <em>{content}</em>;
        if (run.strikethrough) content = <s>{content}</s>;
        const link = run.link;
        if (link !== null) {
          content = (
            <a
              href={link}
              onClick={(event) => {
                event.preventDefault();
                void send({ type: "openChatLink", url: link });
              }}
            >
              {content}
            </a>
          );
        }
        return <span key={index}>{content}</span>;
      })}
    </>
  );
}

/** A thin gradient line pinned to the bottom-left edge of what holds it (the chat, or its question), as
 * wide as the share of `timeout` left. */
function TimeoutBar({ closesAt, timeout }: { closesAt: number; timeout: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnimationFrame(() => {
    if (ref.current) ref.current.style.width = `${remainingFraction(closesAt, Date.now(), timeout) * 100}%`;
  });
  return (
    <div
      ref={ref}
      className="chat-timeout"
      style={{ height: config.chatTimeoutBarHeight, width: `${remainingFraction(closesAt, Date.now(), timeout) * 100}%`, backgroundImage: brandGradient, opacity: config.chatTimeoutBarOpacity }}
    />
  );
}

/** The pill, at most `maxWidth` wide: a long message wraps rather than reach the window's edge. */
function Pill({ mode, level, hasVoice, isRetrying, language, isAgent, maxWidth }: { mode: Mode; level: number; hasVoice: boolean; isRetrying: boolean; language: string | null; isAgent: boolean; maxWidth: number }) {
  const isCircle = mode.kind === "transcribing" || mode.kind === "running" || mode.kind === "resting";
  const isNote = mode.kind === "notPasted";
  const leadingPadding = isCircle ? 0 : mode.kind === "message" || mode.kind === "retrying" || language === null ? config.pillHorizontalPadding : config.languageBadgeInset;
  const ref = useAppear<HTMLDivElement>(appearKeyframes, config.pillSpringResponseSeconds * 1000);
  useNoteHitArea(ref, isNote);
  // Over the note, its box and copy sign take the brand's blue: a click copies.
  const [isNoteHovered, setNoteHovered] = useState(false);
  const style: CSSProperties = {
    gap: config.pillContentSpacing,
    paddingLeft: leadingPadding,
    paddingRight: isCircle ? 0 : config.pillHorizontalPadding,
    paddingTop: isCircle ? 0 : config.pillVerticalPadding,
    paddingBottom: isCircle ? 0 : config.pillVerticalPadding,
    minHeight: config.pillHeight,
    maxWidth,
    borderRadius: config.pillHeight / 2,
    borderWidth: config.pillBorderWidth,
    // A light pill in light and dark mode alike, in a gradient border.
    background: `linear-gradient(${palette.pillFill}, ${palette.pillFill}) padding-box, ${mode.kind === "transcribing" || mode.kind === "running" ? "transparent" : brandGradient} border-box`,
    // Neon red-pink in agent mode, a sign of the mode.
    boxShadow: isAgent
      ? `0 0 ${config.agentPillGlowInnerRadius}px ${rgba(palette.agentPillGlowInner, config.agentPillGlowInnerOpacity)}, 0 0 ${config.agentPillGlowOuterRadius}px ${rgba(palette.agentPillGlowOuter, config.agentPillGlowOuterOpacity)}`
      : `0 0 ${config.pillGlowRadius}px ${brandColor(1, config.pillGlowOpacity)}`,
    transition: `${springTransition(["padding"])}, box-shadow ${config.pillSpringResponseSeconds}s ease-out`,
  };

  // A circle is `pillHeight` across, its border inside, as SwiftUI's `strokeBorder` draws it.
  const circleContent = config.pillHeight - 2 * config.pillBorderWidth;
  let content: ReactNode;
  switch (mode.kind) {
    case "transcribing":
    case "running":
      // An empty circle while the words are worked out or a tool works, in dictation and agent mode
      // alike (owner, 2026-10-07: clean, no icon).
      content = <div style={{ width: circleContent, height: circleContent }} />;
      break;
    case "resting":
      content = (
        <div className="center-content" style={{ width: circleContent, height: circleContent, opacity: config.agentRestingSymbolOpacity }}>
          <SparklesIcon size={config.agentRestingSymbolSize} />
        </div>
      );
      break;
    case "retrying":
      content = (
        <span className="message" style={{ fontSize: config.overlayFontSize, maxWidth: config.pillMaxTextWidth, WebkitLineClamp: config.pillMaxTextLines }}>
          {mode.text}
        </span>
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
    case "notPasted":
      content = (
        <>
          <div className="note-header" style={{ gap: config.pillContentSpacing }}>
            <ClipboardIcon size={config.overlayFontSize} />
            <span className="message" style={{ fontSize: config.overlayFontSize, WebkitLineClamp: config.noteMessageMaxLines }}>
              {mode.message}
            </span>
            <button
              type="button"
              className="note-close"
              aria-label="Dismiss"
              onClick={(event) => {
                // The x dismisses, and copies nothing: the click is not the note's.
                event.stopPropagation();
                void send({ type: "dismissNotPasted" });
              }}
              style={{ width: config.noteCloseButtonSize, height: config.noteCloseButtonSize, fontSize: config.chatCaptionFontSize }}
            >
              ✕
            </button>
          </div>
          {/* The text the click copies, in the chat window's colors for the user's words. */}
          <div
            className="note-text"
            style={{
              gap: config.pillContentSpacing,
              padding: config.noteTextPadding,
              borderRadius: config.noteTextCornerRadius,
              borderWidth: config.pillBorderWidth,
              background: palette.chatRequestFill,
              borderColor: isNoteHovered ? brandBlue : palette.chatRequestBorder,
              ...(isNoteHovered ? { color: brandBlue } : {}),
            }}
          >
            <span className="note-text-content" style={{ fontSize: config.overlayFontSize, WebkitLineClamp: config.noteTextMaxLines }}>
              {mode.text}
            </span>
            <CopyIcon size={config.noteCopyIconSize} />
          </div>
        </>
      );
      break;
    default:
      content = (
        <>
          {language !== null && <LanguageBadge code={language} />}
          <Waveform level={level} hasVoice={hasVoice} />
        </>
      );
  }

  return (
    <div
      ref={ref}
      className={isNote ? "pill note" : "pill"}
      style={isNote ? { ...style, width: Math.min(config.noteWidth, maxWidth), maxHeight: config.noteMaxHeight, padding: config.notePadding, gap: config.pillContentSpacing, borderRadius: config.noteCornerRadius, overflow: "hidden", cursor: "pointer" } : style}
      role={isNote ? "button" : undefined}
      aria-label={isNote ? "Copy" : undefined}
      onPointerEnter={isNote ? () => setNoteHovered(true) : undefined}
      onPointerLeave={isNote ? () => setNoteHovered(false) : undefined}
      onClick={isNote ? () => void send({ type: "copyNotPasted" }) : undefined}
    >
      {content}
      {isNote && <NoteTimeoutBar />}
      {mode.kind === "transcribing" && <SpinningRim isRetrying={isRetrying} />}
      {/* Working: a gradient arc circles the pill's border, as the running tool's bubble's. */}
      {mode.kind === "running" && <CirclingBorder />}
    </div>
  );
}

/** The note's time left, from when it shows (`notPastedDisplayDuration`). */
function NoteTimeoutBar() {
  const [closesAt] = useState(() => Date.now() + config.notPastedDisplayDuration);
  return <TimeoutBar closesAt={closesAt} timeout={config.notPastedDisplayDuration} />;
}

/** While the note for a text not pasted shows, the overlay takes clicks over it: the page says when
 * the pointer is over it (macOS, Windows), and where it is (Linux, where the overlay is cut to it). */
function useNoteHitArea(ref: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const moved = (event: PointerEvent) => void send({ type: "pointerOver", over: event.target instanceof Element && event.target.closest(".note") !== null });
    const left = () => void send({ type: "pointerOver", over: false });
    const measure = () => {
      const frame = element.getBoundingClientRect();
      void send({ type: "noteFrame", frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height } });
    };
    document.addEventListener("pointermove", moved);
    document.documentElement.addEventListener("pointerleave", left);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Again once it has sprung to its size: it appears scaled down.
    const settled = setTimeout(measure, config.pillSpringResponseSeconds * 1000);
    return () => {
      document.removeEventListener("pointermove", moved);
      document.documentElement.removeEventListener("pointerleave", left);
      observer.disconnect();
      clearTimeout(settled);
    };
  }, [active]);
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
        background: `linear-gradient(${palette.pillFill}, ${palette.pillFill}) padding-box, ${brandGradient} border-box`,
      }}
    >
      <span className="gradient-text" style={{ fontSize: config.languageBadgeFontSize, backgroundImage: brandGradient }}>
        {new Intl.Locale(code).language.toUpperCase()}
      </span>
    </div>
  );
}

/** Voice waveform: bars follow the incoming sound level with a traveling ripple, blue until a voice is
 * heard, then its recording colour (`hasVoice`). */
function Waveform({ level, hasVoice }: { level: number; hasVoice: boolean }) {
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
          style={{
            width: config.overlayMeterBarWidth,
            height: config.overlayMeterMinBarHeight,
            borderRadius: config.overlayMeterBarWidth / 2,
            backgroundColor: rgba(hasVoice ? palette.waveformVoiced : palette.waveformWaiting),
            transition: `background-color ${config.colorTransitionSeconds}s ease-in-out`,
          }}
        />
      ))}
    </div>
  );
}

function barHeight(index: number, time: number, level: number): number {
  const count = config.overlayMeterBarCount;
  const center = (count - 1) / 2;
  const distance = Math.abs(index - center) / Math.max(center, 1);
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

/** A ring `width` thick around its box, masked out of a conic gradient. Its inner edge fades over
 * `ringEdgeSoftness`: a hard edge is stair-stepped, and the steps of the circling arc's edge,
 * turning over the still track's, show as dots running around the ring. */
function ringMask(width: number): string {
  const soft = config.ringEdgeSoftness / 2;
  return `radial-gradient(farthest-side, transparent calc(100% - ${width + soft}px), #000 calc(100% - ${width - soft}px))`;
}

/** Loading indicator on the thinking circle's rim: a blue → violet arc with a fading tail, circling
 * over a faint blue ring; while a server error is tried again, both fade to the retry's colors
 * (`palette.retryArcStart` → `palette.retryArcEnd`). A gradient can't ease from one color to
 * another, so the two sets of colors are two layers circling together, one fading out as the other
 * fades in, over `colorTransitionSeconds`. */
function SpinningRim({ isRetrying }: { isRetrying: boolean }) {
  return (
    <>
      <RimLayer start={brandColor(0)} end={brandColor(config.thinkingArcEndColor)} track={brandColor(0, config.thinkingTrackOpacity)} transparent={brandColor(0, 0)} isShown={!isRetrying} />
      <RimLayer start={rgba(palette.retryArcStart)} end={rgba(palette.retryArcEnd)} track={rgba(palette.retryArcStart, config.thinkingTrackOpacity)} transparent={rgba(palette.retryArcStart, 0)} isShown={isRetrying} />
    </>
  );
}

/** One set of the thinking circle's colors: its track and its arc, shown or faded out. */
function RimLayer({ start, end, track, transparent, isShown }: { start: string; end: string; track: string; transparent: string; isShown: boolean }) {
  const width = config.thinkingRimWidth;
  const arc = 360 * config.thinkingArcFraction;
  const ring: CSSProperties = { mask: ringMask(width) };
  return (
    <div className="rim-layer" style={{ opacity: isShown ? 1 : 0, transition: `opacity ${config.colorTransitionSeconds}s ease-in-out` }}>
      <div className="rim" style={{ ...ring, background: track }} />
      <div
        className="rim spinning"
        style={{
          ...ring,
          background: `conic-gradient(${transparent} 0deg, ${start} ${arc / 2}deg, ${end} ${arc}deg, transparent ${arc}deg)`,
          animationDuration: `${1 / config.thinkingRevolutionsPerSecond}s`,
        }}
      />
    </div>
  );
}

/** A bubble's border while its tool runs: a blue → violet highlight sweeping around a faint track. */
function CirclingBorder() {
  const ring: CSSProperties = { mask: ringMask(config.agentBubbleRimWidth) };
  return (
    <>
      <div className="rim" style={{ ...ring, background: brandColor(0, config.thinkingTrackOpacity) }} />
      <div
        className="rim spinning"
        style={{
          ...ring,
          background: `conic-gradient(${brandColor(0, 0)}, ${brandBlue}, ${brandColor(config.thinkingArcEndColor)}, ${brandColor(0, 0)})`,
          animationDuration: `${1 / config.agentBubbleRevolutionsPerSecond}s`,
        }}
      />
    </>
  );
}

/** One of agent mode's bubbles under the pill: a circle with a tool's icon (or its app's icon when
 * it hands the request to an app), or an app's that Answer reaches. While its tool runs (for an app,
 * one of its tools), it springs up larger and a gradient arc circles its border; the other bubbles
 * fade. Further along the row it shows only `opacity` of itself. Under the pointer it grows too, and
 * shows in full, and its tooltip shows (`BubbleTooltip`); the window lets the click through. */
function Bubble({
  label,
  isRunning,
  isDimmed,
  opacity,
  isHovered,
  onHover,
  children,
}: {
  label: string;
  isRunning: boolean;
  isDimmed: boolean;
  opacity: number;
  isHovered: boolean;
  onHover: (isHovered: boolean) => void;
  children: ReactNode;
}) {
  const ref = useAppear<HTMLDivElement>(appearKeyframes, config.pillSpringResponseSeconds * 1000);
  const diameter = config.agentBubbleDiameter;
  return (
    <div ref={ref}>
      <div
        className="bubble"
        aria-label={label}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
        style={{
          width: diameter,
          height: diameter,
          borderWidth: config.pillBorderWidth,
          background: `linear-gradient(${palette.pillFill}, ${palette.pillFill}) padding-box, ${isRunning ? "transparent" : brandGradient} border-box`,
          boxShadow: `0 0 ${config.pillGlowRadius}px ${brandColor(1, config.pillGlowOpacity)}`,
          transform: `scale(${isRunning ? config.agentBubbleRunningScale : isHovered ? config.agentBubbleHoverScale : 1})`,
          opacity: isHovered ? 1 : opacity * (isDimmed ? config.agentBubbleIdleOpacity : 1),
          transition: `transform ${config.agentBubbleRunningSpringResponseSeconds}s ${config.agentBubbleRunningSpringEasing}, opacity ${config.pillSpringResponseSeconds}s ease-out`,
        }}
      >
        {children}
        {isRunning && <CirclingBorder />}
      </div>
    </div>
  );
}

/** What the hovered bubble is: its name over what it does (its Settings description), in a dark
 * tooltip as the tips are, over the bubble or under it when there is no room (`bubbleTooltipCenter`).
 * The pointer passes through it, so it never takes the hover from the bubble under it. */
function BubbleTooltip({ name, description, bubble, canvas }: { name: string; description: string; bubble: Rect; canvas: Size }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const center = bubbleTooltipCenter(bubble, size, canvas);
  return (
    <div
      ref={ref}
      role="tooltip"
      className="centered bubble-tooltip"
      style={{
        left: center.x,
        top: center.y,
        maxWidth: config.bubbleTooltipMaxWidth,
        padding: config.bubbleTooltipPadding,
        gap: config.bubbleTooltipLineSpacing,
        borderRadius: config.tipCornerRadius,
        background: palette.tip.fill,
        border: `${config.pillBorderWidth}px solid ${palette.tip.border}`,
        boxShadow: `0 ${config.tipShadowOffsetY}px ${config.tipShadowRadius}px ${palette.tip.shadow}`,
        // Hidden until measured, so it never shows for a frame where it doesn't belong.
        visibility: size.width > 0 ? "visible" : "hidden",
      }}
    >
      <span className="bubble-tooltip-name" style={{ fontSize: config.bubbleTooltipNameFontSize, color: palette.tip.keyText }}>
        {name}
      </span>
      <span style={{ fontSize: config.bubbleTooltipFontSize, color: palette.tip.text }}>{description}</span>
    </div>
  );
}

/** The tip under the pill, or over it (`tipGoesAbove`), fading in and out; the last one stays while
 * it fades. Hidden until measured: it is placed by its size, so unmeasured it would show for a frame
 * away from the pill. */
function TipSlot({ tip, hotkey, pill, bubbles, opensUpward, gnomeRecordingKeys }: { gnomeRecordingKeys: boolean; tip: DictationTip | null; hotkey: DictationHotkey; pill: Rect; bubbles: Rect[]; opensUpward: boolean }) {
  const [shown, setShown] = useState<DictationTip | null>(tip);
  useEffect(() => {
    if (tip !== null) setShown(tip);
  }, [tip]);
  const [ref, size] = useSize<HTMLDivElement>();
  if (shown === null) return null;
  const above = tipGoesAbove(tipDetails[shown].displayDuration, opensUpward);
  const center = above ? hintCenterOver(pill, bubbles, size) : hintCenter(underBubbles(pill, bubbles), size);
  return (
    <div
      ref={ref}
      className="centered"
      style={{ left: center.x, top: center.y, opacity: tip === null ? 0 : 1, transition: `opacity ${config.pillSpringResponseSeconds}s ease-out`, visibility: size.width > 0 ? "visible" : "hidden" }}
    >
      <TipTooltip gnomeRecordingKeys={gnomeRecordingKeys} tip={shown} hotkey={hotkey} pointsDown={above} />
    </div>
  );
}

/** A tip in a tooltip by the listening pill, under it or over it (`tipGoesAbove`): a dark rounded
 * box with an arrow at the pill (down when `pointsDown`), the tip's words around keycaps. Hidden until
 * measured, as its outline is drawn to its size: never its words for a frame without their box. */
function TipTooltip({ tip, hotkey, pointsDown, gnomeRecordingKeys }: { gnomeRecordingKeys: boolean; tip: DictationTip; hotkey: DictationHotkey; pointsDown: boolean }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const lines = tipLines(tip, hotkey, gnomeRecordingKeys);
  return (
    <div ref={ref} className="tip" style={{ ...(pointsDown ? { paddingBottom: config.tipArrowHeight } : { paddingTop: config.tipArrowHeight }), visibility: size.width > 0 ? "visible" : "hidden" }}>
      <svg className="tip-shape" width={size.width} height={size.height} style={{ filter: `drop-shadow(0 ${config.tipShadowOffsetY}px ${config.tipShadowRadius}px ${palette.tip.shadow})` }}>
        {/* The outline mirrored top to bottom, its arrow at the pill under it; the shadow still falls down. */}
        <path transform={pointsDown ? `translate(0 ${size.height}) scale(1 -1)` : undefined} d={tooltipPath(size)} fill={palette.tip.fill} stroke={palette.tip.border} strokeWidth={config.pillBorderWidth} />
      </svg>
      <div
        className="tip-lines"
        style={{ gap: config.tipLineSpacing, height: config.tipBoxHeight(lines.length), padding: `${config.tipVerticalPadding}px ${config.tipHorizontalPadding}px` }}
      >
        {lines.map((line, index) => (
          <div key={index} className="tip-line" style={{ gap: config.tipSpacing, height: config.tipLineHeight }}>
            {line.map((part, partIndex) =>
              "words" in part ? (
                <span key={partIndex} style={{ fontSize: config.tipFontSize, color: palette.tip.text }}>
                  {part.words}
                </span>
              ) : (
                <span
                  key={partIndex}
                  className="keycap"
                  style={{
                    fontSize: config.tipKeyFontSize,
                    color: palette.tip.keyText,
                    padding: `0 ${config.tipKeyPadding}px`,
                    height: config.tipKeyHeight,
                    borderRadius: config.tipKeyCornerRadius,
                    borderWidth: config.pillBorderWidth,
                    borderColor: palette.tip.keyBorder,
                    background: palette.tip.keyFill,
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

/** A rounded box under an arrow centered on its top edge, one outline so the fill and the border run
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
 * Dispersing plays it in reverse: out from the orbit, fading away. It fades in as it appears and
 * out when `leaving`, with the pill's spring (the Swift swirl's opacity transition), so the wide
 * ring it starts from shows faintly and it reads as the small, soft ring it gathers into. */
function GatheringSwirl({ dispersing, leaving = false }: { dispersing: boolean; leaving?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width, height } = config.overlayCanvasSize;
  useLayoutEffect(() => {
    ref.current?.animate(leaving ? [...fadeKeyframes].reverse() : fadeKeyframes, { duration: config.pillSpringResponseSeconds * 1000, easing: config.pillSpringEasing, fill: leaving ? "forwards" : "backwards" });
  }, [leaving]);
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
      context.fillStyle = brandColor(fraction);
      context.beginPath();
      context.arc(width / 2 + Math.cos(angle) * r, height / 2 + Math.sin(angle) * r, dot / 2, 0, 2 * Math.PI);
      context.fill();
    }
  });
  return <canvas ref={ref} className="swirl" width={width * window.devicePixelRatio} height={height * window.devicePixelRatio} style={{ width, height }} />;
}

const root = document.getElementById("root");
// The overlay is light in light and dark mode alike.
applyPalette(document, false);
if (root) createRoot(root).render(<Overlay />);
