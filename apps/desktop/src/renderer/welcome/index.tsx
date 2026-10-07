// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { alphabetical } from "../../core/agent/bubbleOrder.js";
import { connectorByID, isConnectorID } from "../../core/agent/connectors/index.js";
import { offeredAgentToolIDs, agentTools } from "../../core/agent/tools.js";
import * as config from "../../core/config.js";
import { WelcomeWizard } from "../../core/onboarding/welcomeWizard.js";
import type { WelcomeState } from "../../shared/ipc.js";
import icon from "../../../resources/icon.png";
import { send, useWindowState } from "../shared/bridge.js";
import { BookIcon, ConnectorIcon, LockShieldIcon, MicrophoneIcon, SparklesLineIcon, ToolIcon, ViewfinderIcon } from "../shared/icons.js";
import { NameField } from "../shared/nameField.js";
import { applyPalette } from "../shared/theme.js";
import "../shared/form.css";
import "./index.css";

/** The welcome wizard (`WelcomeView.swift`): the top rail, the current step, and Back / Next. The
 * wizard itself lives in the main process; this draws it and sends the buttons back. */
function Welcome() {
  const state = useWindowState("welcome");
  if (!state) return null;
  return (
    <div className="welcome" style={{ width: config.welcomeWindowSize.width, height: config.welcomeWindowSize.height }}>
      <Rail state={state} />
      <main className="page">
        <Page state={state} />
      </main>
      <footer className="buttons footer">
        <button disabled={state.isFirstStep} onClick={() => void send({ type: "welcomeBack" })}>
          Back
        </button>
        <span className="spacer" />
        <button className="default" disabled={!state.canAdvance} onClick={() => void send({ type: "welcomeNext" })}>
          {state.isLastStep ? "Finish" : "Next"}
        </button>
      </footer>
    </div>
  );
}

function Page({ state }: { state: WelcomeState }) {
  switch (state.step) {
    case "consent":
      return <ConsentPage state={state} />;
    case "name":
      return (
        <StepPage title="Your Name" text="Agent mode writes as you. With your name, it knows which messages on screen are yours, so a reply goes to the other person, not back to you.">
          <NameField initial={state.userName ?? state.suggestedName} placeholder="Your name" />
          <span className="caption">Sent to TabMail with agent mode’s requests, and TabMail doesn’t keep it. You can leave it empty, and change it any time in Settings.</span>
        </StepPage>
      );
    case "microphone":
      return (
        <StepPage title="Microphone" text="TabMail Voice listens only while you hold the dictation key, and turns the microphone off when you let go.">
          <GrantRow granted={state.microphoneGranted} button="Allow Microphone Access" onRequest={() => send({ type: "requestMicrophone" })} />
        </StepPage>
      );
    case "accessibility":
      return (
        <StepPage title={state.keyboardPermission?.title ?? "Accessibility"} text={state.keyboardPermission?.description ?? "Lets TabMail Voice notice the dictation key in any app and type the text where your cursor is. Screen reading uses it too."}>
          <GrantRow granted={state.accessibilityTrusted} button={state.keyboardPermission?.button ?? "Allow Accessibility Access"} onRequest={() => send({ type: "requestAccessibility" })} />
          {!state.accessibilityTrusted && <span className="caption">{state.keyboardPermission?.instructions ?? "In System Settings, turn on TabMail Voice under Privacy & Security › Accessibility."}</span>}
          {state.vscodeFix !== "notNeeded" && <VSCodeFix done={state.vscodeFix === "done"} />}
        </StepPage>
      );
    case "screenReading":
      return (
        <StepPage title="Features" text="Choose what TabMail Voice may use. You can change this any time in Settings.">
          <label className="check">
            <input type="checkbox" checked={state.readsScreen} onChange={(event) => void send({ type: "setReadsScreen", value: event.target.checked })} />
            <span className="stack-text">
              <span>Read the screen while dictating</span>
              <span className="caption">
                When you start dictating, TabMail Voice reads the text in the window in front and sends it with your dictation, so names and terms are spelled as they appear there.
              </span>
            </span>
          </label>
          {state.readsScreen && !state.accessibilityTrusted && <span className="caption">Screen reading needs Accessibility access.</span>}
          <hr />
          <span>Agent mode ({state.keyboardPermission?.agentShortcut ?? "press Space while dictating"}) can:</span>
          {alphabetical([...offeredAgentToolIDs, ...state.connectors]).map((key) =>
            isConnectorID(key) ? (
              <label key={key} className="check">
                <input type="checkbox" checked={state.enabledConnectors.includes(key)} onChange={(event) => void send({ type: "setConnectorEnabled", connector: key, value: event.target.checked })} />
                <span className="stack-text">
                  <span className="labeled-icon">
                    <ConnectorIcon connector={key} size={config.settingsToolIconSize} />
                    {connectorByID[key].displayName}
                  </span>
                  <span className="caption">{connectorByID[key].settingsDescription}</span>
                </span>
              </label>
            ) : (
              <label key={key} className="check">
                <input type="checkbox" checked={state.enabledTools.includes(key)} onChange={(event) => void send({ type: "setAgentToolEnabled", tool: key, value: event.target.checked })} />
                <span className="stack-text">
                  <span className="labeled-icon">
                    <ToolIcon tool={key} size={config.settingsToolIconSize} />
                    {agentTools[key].displayName}
                  </span>
                  <span className="caption">{agentTools[key].settingsDescription}</span>
                </span>
              </label>
            ),
          )}
        </StepPage>
      );
  }
}

function ConsentPage({ state }: { state: WelcomeState }) {
  return (
    <div className="step">
      <div className="hero">
        <img src={icon} alt="" width={config.welcomeIconSize} height={config.welcomeIconSize} />
        <div className="stack-text">
          <h1>Welcome to TabMail Voice</h1>
          <span className="secondary">Hold a key, speak, and TabMail Voice types what you said.</span>
        </div>
      </div>
      <span>To do that, TabMail Voice sends:</span>
      <ul className="sends">
        <li>
          <MicrophoneIcon size={config.welcomeLabelIconSize} />
          <span>Your voice, while you hold the dictation key, to turn it into text. A long dictation is sent in parts while you speak, so its text is ready as soon as you finish.</span>
        </li>
        <li>
          <ViewfinderIcon size={config.welcomeLabelIconSize} />
          <span>
            The text in the window in front, with the app’s name, the window’s title and the website’s address, so names and terms are spelled as they appear there.
            This is screen reading: it’s on unless you switch it off in the Features step or in Settings.
          </span>
        </li>
        <li>
          <BookIcon size={config.welcomeLabelIconSize} />
          <span>
            The words in your dictionary, so they’re spelled your way. You add them in Settings.
            {state.canLearnWords && <> TabMail Voice also learns them: when you correct a name or term it typed, it reads the text field for a short while to see
              the new spelling. That text stays on this computer. Learning is on unless you switch it off in Settings.</>}
          </span>
        </li>
        <li>
          <SparklesLineIcon size={config.welcomeLabelIconSize} />
          <span>In agent mode, your request, the text you’ve selected, and whatever its tools need to do it.</span>
        </li>
        <li>
          <LockShieldIcon size={config.welcomeLabelIconSize} />
          <span>All of it goes to TabMail and the AI providers it uses, only to process that dictation, and isn’t stored.</span>
        </li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={state.hasConsented} onChange={(event) => void send({ type: "setConsent", value: event.target.checked })} />
        <span>I agree to the Terms of Service and the Privacy Policy.</span>
      </label>
      <div className="links">
        <button className="link" onClick={() => void send({ type: "openURL", url: config.termsURL })}>
          Terms of Service
        </button>
        <button className="link" onClick={() => void send({ type: "openURL", url: config.privacyURL })}>
          Privacy Policy
        </button>
      </div>
    </div>
  );
}

function StepPage({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="step">
      <h1>{title}</h1>
      <span>{text}</span>
      {children}
    </div>
  );
}

function GrantRow({ granted, button, onRequest }: { granted: boolean; button: string; onRequest: () => unknown }) {
  if (granted) return <span className="allowed">✓ Allowed</span>;
  return (
    <div>
      <button onClick={() => void onRequest()}>{button}</button>
    </div>
  );
}

/** VS Code with its accessibility support off hides where the cursor is on the line
 * (`vscodeHidesCaret`); one setting in its settings file shows it again. */
function VSCodeFix({ done }: { done: boolean }) {
  return (
    <>
      <hr />
      <span>VS Code’s accessibility support is turned off, so TabMail Voice can’t see where your cursor is on the line there.</span>
      {done ? (
        <span className="allowed">✓ Fixed</span>
      ) : (
        <div>
          <button onClick={() => void send({ type: "fixVSCodeSettings" })}>Fix VS Code’s Settings</button>
        </div>
      )}
      <span className="caption">This sets “editor.editContext” to false in VS Code’s settings, so VS Code uses its classic text input, from the next time you move the cursor. Nothing else changes.</span>
    </>
  );
}

/** Category labels with one bubble per step beneath, as in the Thunderbird welcome wizard: the
 * current category and step are highlighted, passed steps are marked done and can be revisited. */
function Rail({ state }: { state: WelcomeState }) {
  return (
    <nav className="rail" style={{ gap: config.welcomeRailCategorySpacing }}>
      {WelcomeWizard.categories.map((category, categoryIndex) => (
        <div key={category.label} className="category">
          <span className="category-label" style={{ opacity: categoryIndex === state.categoryIndex ? 1 : config.welcomeRailInactiveOpacity }} data-current={categoryIndex === state.categoryIndex}>
            {category.label.toUpperCase()}
          </span>
          <div className="bubbles" style={{ gap: config.welcomeRailBubbleSpacing }}>
            {category.steps.map((step) => {
              const index = WelcomeWizard.steps.indexOf(step);
              const status = index === state.index ? "current" : index < state.index ? "done" : "ahead";
              return (
                <button
                  key={step}
                  className={`step-bubble ${status}`}
                  aria-label={`Step ${index + 1} of ${WelcomeWizard.steps.length}`}
                  disabled={status !== "done"}
                  style={{
                    width: config.welcomeRailBubbleSize,
                    height: config.welcomeRailBubbleSize,
                    transform: `scale(${status === "current" ? config.welcomeRailActiveBubbleScale : 1})`,
                  }}
                  onClick={() => void send({ type: "welcomeGoTo", index })}
                />
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

const root = document.getElementById("root");
applyPalette(document);
if (root) createRoot(root).render(<Welcome />);
