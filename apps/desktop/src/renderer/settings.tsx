// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type CSSProperties, type FormEvent, type ReactNode, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import icon from "../../resources/icon.png";
import { alphabetical } from "../core/agent/bubbleOrder.js";
import { connectorInfo, isConnector } from "../core/agent/connectors.js";
import { offeredAgentTools, toolImplementations } from "../core/agent/tools.js";
import * as config from "../core/config.js";
import { dictionaryWord, isSameWord } from "../core/dictionary.js";
import { dictationHotkeys, hotkeyNames, isDictationHotkey } from "../core/hotkey.js";
import type { SettingsState } from "../shared/ipc.js";
import { brandBlue, brandGradient, brandTextGradient } from "./brand.js";
import { send, useWindowState } from "./bridge.js";
import { BookIcon, ConnectorIcon, GearIcon, LockShieldIcon, MicrophoneIcon, PersonIcon, SparklesLineIcon, ToolIcon } from "./icons.js";
import { NameField } from "./nameField.js";
import "./form.css";
import "./settings.css";

type SectionName = "account" | "dictation" | "dictionary" | "agent" | "permissions" | "general";

/** The sidebar's sections, in order, each with its title and icon. */
const sections: { name: SectionName; title: string; icon: (size: number) => ReactNode }[] = [
  { name: "account", title: "Account", icon: (size) => <PersonIcon size={size} /> },
  { name: "dictation", title: "Dictation", icon: (size) => <MicrophoneIcon size={size} /> },
  { name: "dictionary", title: "Dictionary", icon: (size) => <BookIcon size={size} /> },
  { name: "agent", title: "Agent mode", icon: (size) => <SparklesLineIcon size={size} /> },
  { name: "permissions", title: "Permissions", icon: (size) => <LockShieldIcon size={size} /> },
  { name: "general", title: "General", icon: (size) => <GearIcon size={size} /> },
];

/** macOS draws its traffic lights over the sidebar and the frosted material behind it. */
const isMac = navigator.userAgent.includes("Macintosh");

/** The stylesheet's colours from the brand and the config: `settings.css` reads them. */
const colours = {
  "--brand-gradient": brandGradient,
  "--brand-text-gradient": brandTextGradient,
  "--brand-blue": brandBlue,
  "--window-light": config.settingsWindowColour.light,
  "--window-dark": config.settingsWindowColour.dark,
} as CSSProperties;

/** Whether `name`'s section wants the user's attention: signed out, no name for agent mode, a
 * permission missing, or VS Code's settings hiding the caret. */
function needsAttention(name: SectionName, state: SettingsState): boolean {
  if (name === "account") return state.email === null;
  if (name === "agent") return !hasName(state);
  if (name === "permissions") return !state.microphoneGranted || !state.accessibilityTrusted || state.vscodeFix === "needed";
  return false;
}

/** Settings (`SettingsView.swift`): the account, dictation, agent mode's email app, the
 * permissions and general options, one section at a time, chosen in a sidebar (owner, 2026-09-27:
 * "themed and look professional", the branded sidebar). */
function Settings() {
  const state = useWindowState("settings");
  const [shown, setShown] = useState<SectionName>("account");
  if (!state) return null;
  const section = sections.find((candidate) => candidate.name === shown) ?? sections[0];
  return (
    <div className={isMac ? "settings mac" : "settings"} style={colours}>
      <nav className="sidebar" style={{ width: config.settingsSidebarWidth }}>
        <div className="identity">
          <img src={icon} alt="" width={config.settingsAppIconSize} height={config.settingsAppIconSize} />
          <div>
            <div className="app-name">TabMail Voice</div>
            <div className="caption identity-account">{state.email ?? "Not signed in"}</div>
          </div>
        </div>
        {sections.map(({ name, title, icon: sectionIcon }) => (
          <button key={name} className={name === shown ? "nav selected" : "nav"} aria-current={name === shown ? "page" : undefined} onClick={() => setShown(name)}>
            {sectionIcon(config.settingsSectionIconSize)}
            <span>{title}</span>
            {needsAttention(name, state) && <span className="attention" role="img" aria-label="Needs attention" />}
          </button>
        ))}
      </nav>
      <main className="content">
        <h1>{section?.title}</h1>
        {/* Every pane stays mounted, so a sign-in half done or a sign-out warning outlives a look
            at another section. */}
        <div hidden={shown !== "account"}>
          <AccountPane state={state} />
        </div>
        <div hidden={shown !== "dictation"}>
          <DictationPane state={state} />
        </div>
        <div hidden={shown !== "dictionary"}>
          <DictionaryPane state={state} />
        </div>
        <div hidden={shown !== "agent"}>
          <AgentPane state={state} />
        </div>
        <div hidden={shown !== "permissions"}>
          <PermissionsPane state={state} />
        </div>
        <div hidden={shown !== "general"}>
          <GeneralPane state={state} />
        </div>
      </main>
    </div>
  );
}

function AccountPane({ state }: { state: SettingsState }) {
  return (
    <Group>
      <AccountSection email={state.email} />
    </Group>
  );
}

function DictationPane({ state }: { state: SettingsState }) {
  return (
    <>
      <Group
        captions={[
          state.hotkey === "function" && "While fn is the hotkey, the 🌐 key’s own action in Keyboard settings is set to “Do Nothing”. Your choice comes back when you pick another key or quit.",
          "Your recording is sent to TabMail for transcription and isn’t stored.",
        ]}
      >
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
      </Group>
      <Group>
        <Toggle label="Read the screen while dictating" checked={state.readsScreen} onChange={(value) => send({ type: "setReadsScreen", value })}>
          Sends the text in the window in front with your dictation, so names and terms are spelled as they appear there. It isn’t stored.
        </Toggle>
      </Group>
    </>
  );
}

/** The user's dictionary (ADR-DESK-038): a field to add a word, the words with a remove button each
 * (a learned one tagged so), and the switch for learning from the user's corrections where it can. */
function DictionaryPane({ state }: { state: SettingsState }) {
  const [draft, setDraft] = useState("");
  const word = dictionaryWord(draft);
  const isThere = word !== null && state.dictionary.some((entry) => isSameWord(entry.word, word));
  const isFull = state.dictionary.length >= config.dictionaryMaxEntries;
  let problem: string | null = null;
  if (draft.trim() !== "" && word === null) problem = `A word or name of up to ${config.dictionaryWordMaxWords} words, without < or >.`;
  else if (isFull && !isThere) problem = `The dictionary holds ${config.dictionaryMaxEntries} words. Remove one to add another.`;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (word === null || problem !== null) return;
    void send({ type: "addDictionaryWord", word });
    setDraft("");
  };
  return (
    <>
      <Group captions={["Names and terms spelled your way, kept on this computer. They’re sent with each dictation so they come out right, and TabMail doesn’t keep them."]}>
        <form className="row" onSubmit={add}>
          <input
            type="text"
            className="dictionary-input"
            placeholder="Add a word or name"
            aria-label="Word or name"
            maxLength={config.dictionaryWordMaxChars}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={word === null || problem !== null}>
            Add
          </button>
        </form>
        {problem && (
          <div className="row">
            <span className="error">{problem}</span>
          </div>
        )}
        {state.dictionary.length === 0 ? (
          <div className="row">
            <span className="caption">No words yet.</span>
          </div>
        ) : (
          <ul className="dictionary" aria-label="Dictionary">
            {state.dictionary.map((entry) => (
              <li key={entry.word} className="row">
                <span>
                  {entry.word}
                  {entry.learned && <span className="caption learned"> Learned</span>}
                </span>
                <button className="link" aria-label={`Remove ${entry.word}`} onClick={() => void send({ type: "removeDictionaryWord", word: entry.word })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Group>
      {state.canLearnWords && (
        <Group>
          <Toggle label="Learn from my corrections" checked={state.learnsWords} onChange={(value) => send({ type: "setLearnsWords", value })}>
            For {config.correctionWatchDuration / 1000} seconds after a dictation, watches the text field it went into. When you correct how a word or name was spelled, the new spelling is added here. The field’s text stays on this Mac, and a password field is never read.
          </Toggle>
        </Group>
      )}
    </>
  );
}

/** Whether a name is set for agent mode (`AppSettings.sentUserName`). */
function hasName(state: SettingsState): boolean {
  return (state.userName ?? "").trim() !== "";
}

/** The user's name, then a switch for each agent tool and each app Answer reaches, alphabetically
 * (owner, 2026-09-28), as the bubbles under the pill first show. */
function AgentPane({ state }: { state: SettingsState }) {
  return (
    <>
      <Group
        captions={[
          hasName(state)
            ? "Sent to TabMail with agent mode’s requests, so it knows which messages on screen are yours. TabMail doesn’t keep it."
            : "Add your name so agent mode knows which messages on screen are yours, and a reply goes to the other person, not back to you. It’s sent to TabMail with agent mode’s requests, and TabMail doesn’t keep it.",
        ]}
      >
        <div className="row">
          <span>Your name</span>
          <NameField initial={state.userName ?? ""} placeholder={state.suggestedName === "" ? "Your name" : state.suggestedName} />
        </div>
      </Group>
      <Group>
        {alphabetical([...offeredAgentTools, ...state.connectors]).map((key) =>
          isConnector(key) ? (
            <Toggle
              key={key}
              label={connectorInfo[key].displayName}
              icon={<ConnectorIcon connector={key} size={config.settingsToolIconSize} />}
              checked={state.enabledConnectors.includes(key)}
              onChange={(value) => send({ type: "setConnectorEnabled", connector: key, value })}
            >
              {connectorInfo[key].settingsDescription}
            </Toggle>
          ) : (
            <Toggle
              key={key}
              label={toolImplementations[key].displayName}
              icon={<ToolIcon tool={key} size={config.settingsToolIconSize} />}
              checked={state.enabledTools.includes(key)}
              onChange={(value) => send({ type: "setAgentToolEnabled", tool: key, value })}
            >
              {toolImplementations[key].settingsDescription}
            </Toggle>
          ),
        )}
      </Group>
      {/* Only the Thunderbird tool uses it, and only while that is offered (ADR-DESK-037). */}
      {offeredAgentTools.includes("thunderbird") && <EmailClientPicker state={state} />}
    </>
  );
}

function PermissionsPane({ state }: { state: SettingsState }) {
  return (
    <>
      <Group>
        <PermissionRow title="Microphone" granted={state.microphoneGranted} onRequest={() => send({ type: "requestMicrophone" })} />
        <PermissionRow title="Accessibility (hotkey and typing)" granted={state.accessibilityTrusted} onRequest={() => send({ type: "requestAccessibility" })} />
      </Group>
      {state.vscodeFix !== "notNeeded" && (
        <Group
          captions={[
            "VS Code’s accessibility support is turned off, so TabMail Voice can’t see where your cursor is on the line there. Fixing sets “editor.editContext” to false in VS Code’s settings, so VS Code uses its classic text input, from the next time you move the cursor. Nothing else changes.",
          ]}
        >
          <div className="row">
            <span>VS Code</span>
            {state.vscodeFix === "done" ? <span className="allowed">✓ Fixed</span> : <button onClick={() => void send({ type: "fixVSCodeSettings" })}>Fix Settings</button>}
          </div>
        </Group>
      )}
    </>
  );
}

function GeneralPane({ state }: { state: SettingsState }) {
  return (
    <Group>
      <Toggle label="Open at login" checked={state.openAtLogin} onChange={(value) => send({ type: "setOpenAtLogin", value })} />
      {state.debugAllowed && (
        <Toggle label="Debug mode" checked={state.debugMode} onChange={(value) => send({ type: "setDebugMode", value })}>
          Uses the development server and shows debug items in the menu.
        </Toggle>
      )}
    </Group>
  );
}

/** A card of rows, with the notes under it that apply (a `false` one is left out). */
function Group({ captions = [], children }: { captions?: (string | false)[]; children: ReactNode }) {
  return (
    <section className="card-section">
      <div className="group">{children}</div>
      {captions.map((caption) => caption && <p key={caption} className="caption group-caption">{caption}</p>)}
    </section>
  );
}

/** A setting that is on or off: its label (after its icon, if any), a switch at the end of the row,
 * and what it does. Only the label and the switch toggle it; its note is text to read (or select),
 * as in the Swift app. */
function Toggle({ label, icon, checked, onChange, children }: { label: string; icon?: ReactNode; checked: boolean; onChange: (value: boolean) => unknown; children?: ReactNode }) {
  const id = useId();
  return (
    <div className="row toggle">
      <span className="toggle-text">
        <label htmlFor={id} className={icon ? "labelled-icon" : undefined}>
          {icon}
          {label}
        </label>
        {children && <span className="caption">{children}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(event) => void onChange(event.target.checked)} />
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
    <Group captions={[caption]}>
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
    </Group>
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
          <span className="value">{signedInEmail}</span>
        </div>
        <div className="row">
          <button onClick={() => void run(() => send({ type: "signOut" }), () => {})}>Sign Out</button>
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
