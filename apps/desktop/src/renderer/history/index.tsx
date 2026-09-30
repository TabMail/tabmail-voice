// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as config from "../../core/config.js";
import { pastedAgo } from "../../core/dictation/pasteHistory.js";
import { send, useWindowState } from "../shared/bridge.js";
import "../shared/form.css";
import "./index.css";

/** The paste history a triple tap opens (ADR-DESK-043): the texts pasted, or copied instead, the
 * newest first; a click copies one and closes the window, as Escape does. The window takes the
 * list's height, up to its tallest, then the list scrolls. */
function History() {
  const state = useWindowState("history");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void send({ type: "closeHistory" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    if (height > 0) void send({ type: "historyHeight", height });
  }, [state]);

  if (!state) return null;
  const now = Date.now();
  return (
    <div ref={ref} className="history">
      <div className="history-title">
        Paste history
        {state.entries.length > 0 && <span className="history-hint">Click to copy</span>}
      </div>
      {state.entries.length === 0 ? (
        <div className="history-empty">Nothing pasted yet.</div>
      ) : (
        <div className="history-list" style={{ maxHeight: config.pasteHistoryMaxHeight - config.pasteHistoryChromeHeight }}>
          {state.entries.map((entry) => (
            <button key={entry.id} type="button" className="history-entry" onClick={() => void send({ type: "copyHistoryEntry", id: entry.id })}>
              <div className="history-text" style={{ WebkitLineClamp: config.pasteHistoryEntryLines }}>
                {entry.text}
              </div>
              <div className="history-time">{pastedAgo(entry.at, now)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<History />);
