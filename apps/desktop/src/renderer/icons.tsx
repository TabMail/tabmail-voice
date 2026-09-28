// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ReactNode, useId } from "react";
import type { Connector } from "../core/agent/connectors.js";
import type { AgentTool } from "../core/agent/tools.js";
import { brandBlue, brandPurple } from "./brand.js";

/** An id usable in an SVG `url(#…)` reference. */
function useSvgId(): string {
  return `gradient-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Line icons in the brand gradient, drawn on a 24-point grid (the Swift app's SF Symbols). */
function GradientIcon({ size, children, filled = false }: { size: number; children: ReactNode; filled?: boolean }) {
  const id = useSvgId();
  const paint = `url(#${id})`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={filled ? paint : "none"} stroke={filled ? "none" : paint} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={brandBlue} />
          <stop offset="1" stopColor={brandPurple} />
        </linearGradient>
      </defs>
      {children}
    </svg>
  );
}

const toolPaths: Record<AgentTool, ReactNode> = {
  // A pencil.
  edit: <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  // A square and a pencil.
  compose: (
    <>
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8l-4 1 1-4Z" />
    </>
  ),
  // An envelope.
  thunderbird: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  // A speech bubble with lines of text.
  answer: (
    <>
      <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M8 9h8M8 12.5h5" />
    </>
  ),
};

export function ToolIcon({ tool, size }: { tool: AgentTool; size: number }) {
  return <GradientIcon size={size}>{toolPaths[tool]}</GradientIcon>;
}

const connectorPaths: Record<Connector, ReactNode> = {
  // A calendar page.
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  // A checklist.
  reminders: (
    <>
      <path d="m3.5 6 1.5 1.5 3-3M3.5 12.5 5 14l3-3M3.5 19l1.5 1.5 3-3" />
      <path d="M11 6h9.5M11 12.5h9.5M11 19h9.5" />
    </>
  ),
  // A person in a circle.
  contacts: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.2 18.4a6.5 6.5 0 0 1 11.6 0" />
    </>
  ),
  // A page under a magnifying glass.
  files: (
    <>
      <path d="M13 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v3" />
      <path d="M13 3v5h5" />
      <circle cx="16.5" cy="16.5" r="3" />
      <path d="m18.7 18.7 2.3 2.3" />
    </>
  ),
  // A letter coming out of an open envelope: a new email, not Thunderbird's closed one.
  email: (
    <>
      <path d="M7 12.5V4h10v8.5M9.5 7.5h5M9.5 10h5" />
      <path d="M3 10v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9" />
      <path d="m3 10 9 6 9-6" />
    </>
  ),
};

export function ConnectorIcon({ connector, size }: { connector: Connector; size: number }) {
  return <GradientIcon size={size}>{connectorPaths[connector]}</GradientIcon>;
}

/** Sparkles: an agent tool is at work. */
export function SparklesIcon({ size }: { size: number }) {
  return (
    <GradientIcon size={size} filled>
      <path d="M10 3.5 11.8 8.2 16.5 10 11.8 11.8 10 16.5 8.2 11.8 3.5 10 8.2 8.2Z" />
      <path d="M18 13.5 18.9 15.6 21 16.5 18.9 17.4 18 19.5 17.1 17.4 15 16.5 17.1 15.6Z" />
    </GradientIcon>
  );
}

/** An exclamation mark in a filled circle: a failure. */
export function ExclamationIcon({ size }: { size: number }) {
  const id = useSvgId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={brandBlue} />
          <stop offset="1" stopColor={brandPurple} />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill={`url(#${id})`} />
      <path d="M12 7v6" stroke="white" strokeWidth={2.4} strokeLinecap="round" />
      <circle cx="12" cy="16.8" r="1.4" fill="white" />
    </svg>
  );
}

/** A line icon in the text's colour. */
function PlainIcon({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function MicrophoneIcon({ size }: { size: number }) {
  return (
    <PlainIcon size={size}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </PlainIcon>
  );
}

/** Text in a viewfinder: screen reading. */
export function ViewfinderIcon({ size }: { size: number }) {
  return (
    <PlainIcon size={size}>
      <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M8 9h8M8 12h8M8 15h5" />
    </PlainIcon>
  );
}

/** A lock on a shield: not stored. */
export function LockShieldIcon({ size }: { size: number }) {
  return (
    <PlainIcon size={size}>
      <path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.4 7.5 10 4.3-1.6 7.5-5.4 7.5-10v-6Z" />
      <rect x="9" y="11" width="6" height="5" rx="1" />
      <path d="M10 11V9.5a2 2 0 0 1 4 0V11" />
    </PlainIcon>
  );
}

/** A person: the account. */
export function PersonIcon({ size }: { size: number }) {
  return (
    <PlainIcon size={size}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </PlainIcon>
  );
}

/** Sparkles in outline: agent mode. */
export function SparklesLineIcon({ size }: { size: number }) {
  return (
    <PlainIcon size={size}>
      <path d="M10 3.5 11.8 8.2 16.5 10 11.8 11.8 10 16.5 8.2 11.8 3.5 10 8.2 8.2Z" />
      <path d="M18 14 18.8 15.7 20.5 16.5 18.8 17.3 18 19 17.2 17.3 15.5 16.5 17.2 15.7Z" />
    </PlainIcon>
  );
}

/** A gear: general options. */
export function GearIcon({ size }: { size: number }) {
  return (
    <PlainIcon size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </PlainIcon>
  );
}
