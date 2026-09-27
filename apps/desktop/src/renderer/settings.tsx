// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type FormEvent, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { dictationHotkeys, hotkeyNames, isDictationHotkey } from "../core/hotkey.js";
import type { SettingsState } from "../shared/ipc.js";
import { send, useWindowState } from "./bridge.js";
import "./form.css";

/** Settings (`SettingsView.swift`): the account, dictation, agent mode's email app, the
 * permissions and general options. */
function Settings() {
  const state = useWindowState("settings");
  if (!state) return null;
  return (
    <div className="form">
      <Section title="Account">
        <AccountSection email={state.email} />
      </Section>

      <Section title="Dictation">
        <div className="row">
          <span>Hold to dictate</span>
          <select
            value={state.hotkey}
            onChange={(event) => {
              if (isDictationHotkey(event.target.value)) void send({ type: "setHotkey", hotkey: event.target.value });
            }}
          >
            {dictationHotkeys.map((hotkey) => (
              <option key={hotkey} value={hotkey}>
                {hotkeyNames[hotkey].displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="row stack">
          {state.hotkey === "function" && (
            <span className="caption">While fn is the hotkey, the 🌐 key’s own action in Keyboard settings is set to “Do Nothing”. Your choice comes back when you pick another key or quit.</span>
          )}
          <span className="caption">Your recording is sent to TabMail for transcription and isn’t stored.</span>
        </div>
        <Toggle label="Read the screen while dictating" checked={state.readsScreen} onChange={(value) => send({ type: "setReadsScreen", value })}>
          Sends the text in the window in front with your dictation, so names and terms are spelled as they appear there. It isn’t stored.
        </Toggle>
      </Section>

      <Section title="Agent mode">
        <EmailClientPicker state={state} />
      </Section>

      <Section title="Permissions">
        <PermissionRow title="Microphone" granted={state.microphoneGranted} onRequest={() => send({ type: "requestMicrophone" })} />
        <PermissionRow title="Accessibility (hotkey and typing)" granted={state.accessibilityTrusted} onRequest={() => send({ type: "requestAccessibility" })} />
      </Section>

      <Section title="General">
        <Toggle label="Open at login" checked={state.openAtLogin} onChange={(value) => send({ type: "setOpenAtLogin", value })} />
        {state.debugAllowed && (
          <Toggle label="Debug mode" checked={state.debugMode} onChange={(value) => send({ type: "setDebugMode", value })}>
            Uses the development server and shows debug items in the menu.
          </Toggle>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <div className="group">{children}</div>
    </section>
  );
}

function Toggle({ label, checked, onChange, children }: { label: string; checked: boolean; onChange: (value: boolean) => unknown; children?: ReactNode }) {
  return (
    <div className="row stack">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(event) => void onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
      {children && <span className="caption">{children}</span>}
    </div>
  );
}

function PermissionRow({ title, granted, onRequest }: { title: string; granted: boolean; onRequest: () => unknown }) {
  return (
    <div className="row">
      <span>{title}</span>
      {granted ? <span className="allowed">✓ Allowed</span> : <button onClick={() => void onRequest()}>Allow…</button>}
    </div>
  );
}

/** Which email app mail and calendar requests go to: the default email app, or a Thunderbird
 * installed on this Mac. */
function EmailClientPicker({ state }: { state: SettingsState }) {
  const defaultValue = "";
  let caption: string;
  if (!state.hasTabMail) caption = "TabMail’s add-on isn’t installed in Thunderbird, so mail and calendar requests aren’t offered.";
  else if (state.emailClient === null && !state.defaultEmailAppIsSupported) caption = "Mail and calendar requests need Thunderbird with TabMail. Choose it here, or make it your default email app.";
  else caption = "Mail and calendar requests go to TabMail’s chat in this app.";
  return (
    <>
      <div className="row">
        <span>Email app</span>
        <select value={state.emailClient ?? defaultValue} onChange={(event) => void send({ type: "setEmailClient", bundleIdentifier: event.target.value === defaultValue ? null : event.target.value })}>
          <option value={defaultValue}>Default ({state.systemEmailApp?.name ?? "none"})</option>
          {state.installedEmailApps.map((app) => (
            <option key={app.bundleIdentifier} value={app.bundleIdentifier}>
              {app.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span className="caption">{caption}</span>
      </div>
    </>
  );
}

/** Email-code sign-in for an existing TabMail account. */
function AccountSection({ email: signedInEmail }: { email: string | null }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function run(work: () => Promise<{ error: string | null }>, then: () => void): Promise<void> {
    setBusy(true);
    setErrorMessage(null);
    const { error } = await work();
    if (error === null) then();
    else setErrorMessage(error);
    setBusy(false);
  }

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !email.includes("@")) return;
    void run(() => send({ type: "sendCode", email }), () => setCodeSent(true));
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    if (busy || code === "") return;
    void run(
      () => send({ type: "verify", email, code }),
      () => {
        setCode("");
        setCodeSent(false);
      },
    );
  };

  const error = errorMessage && <span className="error">{errorMessage}</span>;

  if (signedInEmail !== null) {
    return (
      <>
        <div className="row">
          <span>Signed in as</span>
          <span>{signedInEmail}</span>
        </div>
        <div className="row">
          <button onClick={() => void send({ type: "signOut" })}>Sign Out</button>
        </div>
      </>
    );
  }

  if (codeSent) {
    return (
      <form className="row stack" onSubmit={verify}>
        <span>Enter the code we emailed to {email}.</span>
        <input type="text" placeholder="Code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} autoFocus />
        <div className="buttons">
          <button
            type="button"
            onClick={() => {
              setCodeSent(false);
              setCode("");
              setErrorMessage(null);
            }}
          >
            Use a Different Email
          </button>
          <span className="spacer" />
          <button type="submit" className="default" disabled={busy || code === ""}>
            Sign In
          </button>
        </div>
        {error}
      </form>
    );
  }

  return (
    <form className="row stack" onSubmit={sendCode}>
      <input type="email" placeholder="Email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <div className="buttons">
        <button type="submit" className="default" disabled={busy || !email.includes("@")}>
          Email Me a Code
        </button>
      </div>
      {error}
    </form>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Settings />);
