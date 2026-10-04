// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createRoot } from "react-dom/client";
import { useWindowState } from "../shared/bridge.js";
import { applyPalette } from "../shared/theme.js";
import "../shared/form.css";

/** Debug builds only: the last captured screen context (`ScreenContextDebugView.swift`). */
function ContextDebug() {
  const state = useWindowState("contextDebug");
  if (!state) return null;
  const context = state.context;
  if (!context) return <div className="form">Dictate once to capture the screen context.</div>;
  return (
    <div className="form">
      <Section title="Summary" text={context.summary} />
      <Section title="Window title" text={context.windowTitle ?? ""} />
      <Section title="Before caret" text={context.textBeforeCaret} />
      <Section title="Selected" text={context.selectedText} />
      <Section title="After caret" text={context.textAfterCaret} />
      <Section title="Visible text" text={context.renderedText} />
    </div>
  );
}

function Section({ title, text }: { title: string; text: string }) {
  return (
    <section className="group row stack">
      <strong>{title}</strong>
      <pre>{text === "" ? "—" : text}</pre>
    </section>
  );
}

const root = document.getElementById("root");
applyPalette(document);
if (root) createRoot(root).render(<ContextDebug />);
