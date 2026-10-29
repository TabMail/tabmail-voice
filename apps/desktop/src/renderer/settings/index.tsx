// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import icon from "../../../resources/icon.png";
import { alphabetical } from "../../core/agent/bubbleOrder.js";
import { connectorByID, isConnectorID } from "../../core/agent/connectors/index.js";
import { eventDurationLabel } from "../../core/agent/connectors/settings.js";
import { offeredAgentToolIDs, switchableAgentToolIDs, agentTools } from "../../core/agent/tools.js";
import * as config from "../../core/config.js";
import { excludedSite } from "../../core/dictation/excludedSites.js";
import { type DictionaryEntry, dictionaryWord, isSameWord } from "../../core/dictionary/entries.js";
import { hotkeyNames, isDictationHotkey } from "../../core/hotkey/bindings.js";
import { formatBytes, memoryHighlights } from "../../core/memory/page.js";
import { memoryDate, memoryExchange } from "../../core/memory/store.js";
import type { PromptHistoryItem } from "../../core/personalization/page.js";
import { fileProblemLine } from "../../core/ui/fileProblems.js";
import { type UpdateState, updateItem } from "../../core/ui/menuModel.js";
import type { Command, SettingsState } from "../../shared/ipc.js";
import { send, useWindowState } from "../shared/bridge.js";
import { BookIcon, ConnectorIcon, EyeOffIcon, GearIcon, HistoryIcon, LockShieldIcon, MicrophoneIcon, PenIcon, PersonIcon, SparklesLineIcon, ToolIcon } from "../shared/icons.js";
import { NameField } from "../shared/nameField.js";
import { applyPalette } from "../shared/theme.js";
import "../shared/form.css";
import "./index.css";

type SectionName = "account" | "dictation" | "dictionary" | "agent" | "personalization" | "memory" | "privacy" | "permissions" | "general";

/** The sidebar's sections, in order, each with its title and icon. */
const sections: { name: SectionName; title: string; icon: (size: number) => ReactNode }[] = [
  { name: "account", title: "Account", icon: (size) => <PersonIcon size={size} /> },
  { name: "dictation", title: "Dictation", icon: (size) => <MicrophoneIcon size={size} /> },
  { name: "dictionary", title: "Dictionary", icon: (size) => <BookIcon size={size} /> },
  { name: "agent", title: "Agent mode", icon: (size) => <SparklesLineIcon size={size} /> },
  { name: "personalization", title: "Personalization", icon: (size) => <PenIcon size={size} /> },
  { name: "memory", title: "Memory", icon: (size) => <HistoryIcon size={size} /> },
  { name: "privacy", title: "Privacy", icon: (size) => <EyeOffIcon size={size} /> },
  { name: "permissions", title: "Permissions", icon: (size) => <LockShieldIcon size={size} /> },
  { name: "general", title: "General", icon: (size) => <GearIcon size={size} /> },
];

/** macOS draws its traffic lights over the sidebar and the frosted material behind it. */
const isMac = navigator.userAgent.includes("Macintosh");

/** Whether the sidebar offers `name`'s section: Privacy only where apps can be excluded from screen
 * reading (`canExcludeApps`, macOS). */
function isOffered(name: SectionName, state: SettingsState): boolean {
  return name !== "privacy" || state.canExcludeApps;
}

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
  // Memory is read afresh each time its section shows: requests kept since are listed.
  useEffect(() => {
    if (shown === "memory") void send({ type: "loadMemory" });
  }, [shown]);
  if (!state) return null;
  const section = sections.find((candidate) => candidate.name === shown) ?? sections[0];
  return (
    <div className={isMac ? "settings mac" : "settings"}>
      <nav className="sidebar" style={{ width: config.settingsSidebarWidth }}>
        <div className="identity">
          <img src={icon} alt="" width={config.settingsAppIconSize} height={config.settingsAppIconSize} />
          <div>
            <div className="app-name">TabMail Voice</div>
            <div className="caption identity-account">{state.email ?? "Not signed in"}</div>
          </div>
        </div>
        {sections.filter(({ name }) => isOffered(name, state)).map(({ name, title, icon: sectionIcon }) => (
          <button key={name} className={name === shown ? "nav selected" : "nav"} aria-current={name === shown ? "page" : undefined} onClick={() => setShown(name)}>
            {sectionIcon(config.settingsSectionIconSize)}
            <span>{title}</span>
            {needsAttention(name, state) && <span className="attention" role="img" aria-label="Needs attention" />}
          </button>
        ))}
      </nav>
      <main className="content">
        <h1>{section?.title}</h1>
        {state.fileProblems.map((file) => (
          <p key={file} className="error file-problem" role="alert">
            {fileProblemLine(file)}
          </p>
        ))}
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
        <div hidden={shown !== "personalization"}>
          <PersonalizationPane state={state} />
        </div>
        <div hidden={shown !== "memory"}>
          <MemoryPane state={state} />
        </div>
        {isOffered("privacy", state) && (
          <div hidden={shown !== "privacy"}>
            <PrivacyPane state={state} />
          </div>
        )}
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
          (state.hotkey === "F8" || state.hotkey === "F9") && `Hold ${state.hotkey} to dictate, or double-tap for hands-free. Shift+${state.hotkey} starts agent mode; Ctrl+Shift+${state.hotkey} cancels.`,
          state.hotkey !== "F8" && state.hotkey !== "F9" && "Hold Shift with your dictation key to start agent mode directly. Press Space while dictating to switch modes.",
          // Ubuntu: the portal cannot bind a lone modifier, so GNOME integration holds Right Alt.
          state.hotkey === "rightAlt" && state.gnomeIntegration !== undefined && state.gnomeIntegration !== "ready" && "Right Alt works once GNOME integration is enabled in Permissions.",
          state.hotkey === "rightAlt" && state.hotkeyUnavailable === true && "Right Alt types characters with this keyboard layout (AltGr), so it can’t be the dictation key. Choose F8 or F9.",
          "Your recording is used only to transcribe it, and is never stored.",
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
            {state.availableHotkeys.map((hotkey) => (
              <option key={hotkey} value={hotkey}>
                {hotkeyNames[hotkey].displayName}
              </option>
            ))}
          </select>
        </div>
      </Group>
      <Group>
        <Toggle label="Smart dictation" checked={state.smartDictation} onChange={(value) => send({ type: "setSmartDictation", value })}>
          Lets AI clean up your dictation: names and terms spelled as on screen, filler words removed, grammar fixed. Adds a delay of a second or more to each dictation; turn it off for faster, word-for-word dictation.
        </Toggle>
      </Group>
      <Group>
        <Toggle label="Read the screen while dictating" checked={state.readsScreen} onChange={(value) => send({ type: "setReadsScreen", value })}>
          Uses the text in the window you’re dictating into, so names and terms come out right. Passwords and secrets are left out, and nothing is stored.
        </Toggle>
      </Group>
    </>
  );
}

/** The user's dictionary (ADR-DESK-038): a field to add a word, the words with a remove button each
 * (the typed ones first, then the learned ones, tagged so, each alphabetically), and the switch for
 * learning from the user's corrections where it can. Learned words can run to thousands (#310), so
 * above the list are how many of each there are and a field that shows only the words containing what
 * is typed in it, whatever the case. */
function DictionaryPane({ state }: { state: SettingsState }) {
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const word = dictionaryWord(draft);
  const existing = word === null ? undefined : state.dictionary.find((entry) => isSameWord(entry.word, word));
  // Typed words are capped; learned ones make room for them. Retyping a typed word adds none.
  const isFull = state.dictionary.filter((entry) => !entry.learned).length >= config.dictionaryMaxTypedWords && existing?.learned !== false;
  const byWord = (a: DictionaryEntry, b: DictionaryEntry) => a.word.localeCompare(b.word);
  const typed = state.dictionary.filter((entry) => !entry.learned);
  const learned = state.dictionary.filter((entry) => entry.learned);
  const needle = filter.trim().toLowerCase();
  const shown = [...typed.sort(byWord), ...learned.sort(byWord)].filter((entry) => entry.word.toLowerCase().includes(needle));
  let problem: string | null = null;
  if (draft.trim() !== "" && word === null) problem = `A word or name of up to ${config.dictionaryWordMaxWords} words, without < or >.`;
  else if (isFull) problem = `You can add up to ${config.dictionaryMaxTypedWords} words. Remove one to add another.`;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (word === null || problem !== null) return;
    void send({ type: "addDictionaryWord", word });
    setDraft("");
  };
  return (
    <>
      <Group captions={["Names and terms spelled your way, kept on this computer. The ones you use most are sent with each dictation so they come out right, and TabMail doesn’t keep them."]}>
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
          <>
            <div className="row">
              <span className="caption">
                {typed.length} added by you, {learned.length} learned
              </span>
            </div>
            <div className="row">
              <input type="search" className="dictionary-input" placeholder="Filter" aria-label="Filter the dictionary" value={filter} onChange={(event) => setFilter(event.target.value)} />
            </div>
            {shown.length === 0 && (
              <div className="row">
                <span className="caption">No words match.</span>
              </div>
            )}
            <ul className="dictionary" aria-label="Dictionary">
              {shown.map((entry) => (
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
          </>
        )}
      </Group>
      {state.canLearnWords && (
        <Group>
          <Toggle label="Learn from my corrections" checked={state.learnsWords} onChange={(value) => send({ type: "setLearnsWords", value })}>
            For {config.correctionWatchDuration / 1000} seconds after a dictation, watches the text field it went into. When you correct how a word or name was spelled, the new spelling is added here. Learned words fill the room your own words leave, up to {config.dictionaryMaxEntries.toLocaleString("en-US")} in all, and the one used least recently makes way for a new one. The field’s text stays on this computer, and a password field is never read.
          </Toggle>
        </Group>
      )}
    </>
  );
}

/** The websites the screen is never read on (owner, 2026-10-01): the web vaults excluded in every
 * installation, named, a field to add a site by its address, and the user's sites, each with a
 * remove button. */
function ExcludedSites({ state }: { state: SettingsState }) {
  const [draft, setDraft] = useState("");
  /** What the last add or remove was refused for (a list that could not be saved), until the next. */
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (command: Command) => {
    setFailure(null);
    const { error } = await send(command);
    setFailure(error);
  };
  const site = excludedSite(draft);
  const problem = draft.trim() !== "" && site === null ? "A website’s address, like example.com." : null;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (site === null || problem !== null) return;
    void run({ type: "excludeSite", site });
    setDraft("");
  };
  return (
    <Group
      captions={[
        "On these websites, and their subdomains, TabMail Voice never reads the screen, whichever browser they are open in.",
        `Password managers’ websites are always excluded: ${config.builtInExcludedSites.join(", ")}.`,
      ]}
    >
      <div className="row">
        <span>Excluded websites</span>
      </div>
      <form className="row" onSubmit={add}>
        <input
          type="text"
          className="dictionary-input"
          placeholder="Add a website, like example.com"
          aria-label="Website"
          maxLength={config.excludedSiteInputMaxLength}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={site === null || problem !== null}>
          Add
        </button>
      </form>
      {problem !== null && (
        <div className="row">
          <span className="error">{problem}</span>
        </div>
      )}
      {failure !== null && (
        <div className="row">
          <span className="error">{failure}</span>
        </div>
      )}
      {state.excludedSites.length === 0 ? (
        <div className="row">
          <span className="caption">No websites added yet.</span>
        </div>
      ) : (
        <ul className="dictionary" aria-label="Excluded websites">
          {state.excludedSites.map((host) => (
            <li key={host} className="row">
              <span>{host}</span>
              <button className="link" aria-label={`Remove ${host}`} onClick={() => void run({ type: "removeExcludedSite", host })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

/** Opt Out of AI first (device-only, #289), then the apps the screen is never read in (owner,
 * 2026-09-30): the password managers excluded in every installation, named, and the apps the user
 * adds, each with a remove button. */
function PrivacyPane({ state }: { state: SettingsState }) {
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (command: Command) => {
    setProblem(null);
    const { error } = await send(command);
    setProblem(error);
  };
  /** A choice that couldn't be saved is said under the switch, which shows what is saved. */
  const [optOutProblem, setOptOutProblem] = useState<string | null>(null);
  const optOut = async (value: boolean) => {
    setOptOutProblem(null);
    const { error } = await send({ type: "setOptsOutOfAI", value });
    setOptOutProblem(error);
  };
  return (
    <>
      <Group>
        <Toggle label="Opt Out of AI" checked={state.optsOutOfAI} onChange={optOut} extra={optOutProblem !== null && <span className="error">{optOutProblem}</span>}>
          Turns off dictation, agent mode and memory, so nothing you say or have on screen is sent to AI. Signing in and updates still work. On this computer only.
        </Toggle>
      </Group>
      <Group
        captions={[
          "In these apps TabMail Voice never reads the screen: nothing in their windows is sent with a dictation or used to learn a spelling. Dictation still works there.",
          ...(state.builtInExcludedApps.length ? [`Password managers are always excluded: ${state.builtInExcludedApps.map((app) => app.name).join(", ")}.`] : []),
        ]}
      >
        <div className="row">
          <span>Excluded apps</span>
          <button onClick={() => void run({ type: "excludeApp" })}>
            Add App…
          </button>
        </div>
        {problem !== null && (
          <div className="row">
            <span className="error">{problem}</span>
          </div>
        )}
        {state.excludedApps.length === 0 ? (
          <div className="row">
            <span className="caption">No apps added yet.</span>
          </div>
        ) : (
          <ul className="dictionary" aria-label="Excluded apps">
            {state.excludedApps.map((app) => (
              <li key={app.bundleIdentifier} className="row">
                <span>{app.name}</span>
                <button className="link" aria-label={`Remove ${app.name}`} onClick={() => void run({ type: "removeExcludedApp", bundleIdentifier: app.bundleIdentifier })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Group>
      <ExcludedSites state={state} />
    </>
  );
}

/** Whether a name is set for agent mode (`AppSettings.sentUserName`). */
function hasName(state: SettingsState): boolean {
  return (state.userName ?? "").trim() !== "";
}

/** The user's name, then a switch for each switchable agent tool (Answer, always on, has none) and
 * each app Answer reaches, alphabetically (owner, 2026-09-28), as the bubbles under the pill first
 * show. */
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
        {alphabetical([...switchableAgentToolIDs, ...state.connectors]).map((key) =>
          isConnectorID(key) ? (
            <Toggle
              key={key}
              label={connectorByID[key].displayName}
              icon={<ConnectorIcon connector={key} size={config.settingsToolIconSize} />}
              checked={state.enabledConnectors.includes(key)}
              onChange={(value) => send({ type: "setConnectorEnabled", connector: key, value })}
              extra={key === "calendar" ? <EventDurationPicker state={state} /> : undefined}
            >
              {connectorByID[key].settingsDescription}
            </Toggle>
          ) : (
            <Toggle
              key={key}
              label={agentTools[key].displayName}
              icon={<ToolIcon tool={key} size={config.settingsToolIconSize} />}
              checked={state.enabledTools.includes(key)}
              onChange={(value) => send({ type: "setAgentToolEnabled", tool: key, value })}
            >
              {agentTools[key].settingsDescription}
            </Toggle>
          ),
        )}
      </Group>
      <Group>
        <Toggle label="Close the chat when I click elsewhere" checked={state.closesChatElsewhere} onChange={(value) => send({ type: "setClosesChatElsewhere", value })}>
          It also closes when you switch to another app. It stays open while it’s listening, thinking, or waiting for your answer.
        </Toggle>
      </Group>
      {/* Only the Thunderbird tool uses it, and only while that is offered (ADR-DESK-037). */}
      {offeredAgentToolIDs.includes("thunderbird") && <EmailClientPicker state={state} />}
    </>
  );
}

/** Past agent-mode requests (ADR-DESK-061), a port of Thunderbird's Chat History tab: memory used
 * against the size limit, as a bar, with the limit to choose; the requests, the newest first, with
 * a search and a reload; a remove button on each; and Clear All, confirmed in place. */
function MemoryPane({ state }: { state: SettingsState }) {
  const memory = state.memory;
  const [draft, setDraft] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  /** A lower size limit chosen, waiting to be confirmed: it removes the oldest requests for good. */
  const [confirmingLimit, setConfirmingLimit] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** The requests being removed: each one's button says so until its own removal has answered. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  /** Set once a Reload has answered, as Thunderbird's Chat History says it refreshed; the next
   * command clears it. */
  const [reloaded, setReloaded] = useState(false);
  const commands = useRef(0);
  /** Sends `command`; true when it answered without an error and no later command was sent. */
  const run = async (command: Command): Promise<boolean> => {
    const sent = ++commands.current;
    setFailure(null);
    setReloaded(false);
    const { error } = await send(command);
    setFailure(error);
    return error === null && sent === commands.current;
  };
  const reload = async () => {
    if (await run({ type: "loadMemory" })) setReloaded(true);
  };
  const remove = async (memId: string) => {
    setRemoving((current) => new Set(current).add(memId));
    await run({ type: "removeMemory", memId });
    setRemoving((current) => {
      const next = new Set(current);
      next.delete(memId);
      return next;
    });
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    void run({ type: "searchMemory", query: draft.trim() });
  };
  const chooseLimit = (value: number) => {
    // A lower limit can remove requests for good: asked first, as Clear All is, whatever memory is
    // shown to hold; so is the first limit while it is "Not set". The list keeps the limit in
    // force until then.
    if (limit === null || value < limit) setConfirmingLimit(value);
    else {
      setConfirmingLimit(null);
      void run({ type: "setMemorySizeLimit", value });
    }
  };
  /** `text` with the search's words marked, as Thunderbird's Chat History marks them (#246). */
  const marked = (text: string) =>
    memoryHighlights(text, memory.query).map((part, index) =>
      part.match ? (
        <mark key={index} className="memory-match">
          {part.text}
        </mark>
      ) : (
        part.text
      ),
    );
  const used = memory.usage?.usedBytes;
  /** Null, "Not set", while the user's limit is unknown: no request is kept until one is chosen. */
  const limit = memory.sizeLimit;
  return (
    <>
      <Group
        captions={[
          "Agent mode’s requests, and what it answered or wrote, are kept on this computer so it can look back at them when you ask. Plain dictation isn’t kept.",
          limit === null ? "Size limit not set: agent mode’s requests aren’t kept until you choose one." : "When memory reaches the limit, the oldest requests are removed first.",
        ]}
      >
        <div className="row stack">
          <span>
            {memory.unavailable
              ? `Memory used: unavailable (limit ${limit === null ? "not set" : formatBytes(limit)})`
              : used === undefined
                ? "Memory used: reading…"
                : `Memory used: ${formatBytes(used)}${limit === null ? "" : ` of ${formatBytes(limit)}`}`}
          </span>
          {limit !== null && (
            <div className="usage-bar" role="progressbar" aria-label="Memory used" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used ?? 0, limit)}>
              <div className={(used ?? 0) > 0 ? "usage-fill some" : "usage-fill"} style={{ width: `${(Math.min(used ?? 0, limit) / limit) * 100}%` }} />
            </div>
          )}
        </div>
        <div className="row">
          <span>Size limit</span>
          <select aria-label="Size limit" value={limit ?? ""} onChange={(event) => chooseLimit(Number(event.target.value))}>
            {limit === null && (
              <option value="" disabled>
                Not set
              </option>
            )}
            {config.memorySizeLimitChoices.map((bytes) => (
              <option key={bytes} value={bytes}>
                {formatBytes(bytes)}
              </option>
            ))}
          </select>
        </div>
        {confirmingLimit !== null && (
          <div className="row stack">
            <span>
              {limit === null ? `Set the limit to ${formatBytes(confirmingLimit)}? If memory holds more, its oldest requests are removed.` : `Lower the limit to ${formatBytes(confirmingLimit)}? The oldest requests above it are removed.`} This can’t be undone.
            </span>
            <div className="buttons">
              <button onClick={() => setConfirmingLimit(null)}>Cancel</button>
              <button
                className="default"
                onClick={() => {
                  setConfirmingLimit(null);
                  void run({ type: "setMemorySizeLimit", value: confirmingLimit });
                }}
              >
                {limit === null ? "Set Limit" : "Lower Limit"}
              </button>
            </div>
          </div>
        )}
        {memory.status !== null && (
          <div className="row">
            <span className="caption">{memory.status}</span>
          </div>
        )}
      </Group>
      <Group>
        <form className="row" onSubmit={search}>
          <input
            type="text"
            placeholder="Search past requests"
            aria-label="Search past requests"
            maxLength={config.memorySearchMaxLength}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit">Search</button>
          {/* Requests kept while the section is open are listed once it is read again. */}
          <button type="button" onClick={() => void reload()}>
            Reload
          </button>
        </form>
        {failure !== null && (
          <div className="row">
            <span className="error">{failure}</span>
          </div>
        )}
        {reloaded && (
          <div className="row">
            <span className="caption">Memory reloaded.</span>
          </div>
        )}
        {memory.entries.length === 0 ? (
          <div className="row">
            <span className="caption">
              {memory.unavailable
                ? "Memory can’t be read right now. Try again in a moment."
                : memory.searchFailed === "refused"
                  ? `Couldn’t search for “${memory.query}”. Try other words.`
                  : memory.searchFailed === "failed"
                    ? "Requests can’t be listed right now. Try again in a moment."
                  : memory.query !== ""
                    ? `No requests found for “${memory.query}”.`
                    : memory.usage === null
                      ? "Reading…"
                      : "No requests kept yet."}
            </span>
          </div>
        ) : (
          <ul className="dictionary" aria-label="Past requests">
            {memory.entries.map((entry) => {
              const { request, agent } = memoryExchange(entry.content);
              return (
                <li key={entry.memId} className="row memory-entry">
                  <div className="memory-text">
                    <span className="caption">{memoryDate(entry.dateMs)}</span>
                    {request !== "" && <span className="memory-request">{marked(request)}</span>}
                    <span className="memory-reply">{marked(agent)}</span>
                  </div>
                  <button className="link" aria-label={`Remove the request from ${memoryDate(entry.dateMs)}`} disabled={removing.has(entry.memId)} onClick={() => void remove(entry.memId)}>
                    {removing.has(entry.memId) ? "Removing…" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Group>
      <Group>
        {confirmingClear ? (
          <div className="row stack">
            <span>Remove every request kept? This can’t be undone.</span>
            <div className="buttons">
              <button onClick={() => setConfirmingClear(false)}>Cancel</button>
              <button
                className="default"
                onClick={() => {
                  setConfirmingClear(false);
                  void run({ type: "clearMemory" });
                }}
              >
                Clear All
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <span>{memory.usage ? `${memory.usage.docs} ${memory.usage.docs === 1 ? "request" : "requests"} kept` : "Requests kept"}</span>
            <button onClick={() => setConfirmingClear(true)}>
              Clear All…
            </button>
          </div>
        )}
      </Group>
    </>
  );
}

/** How a writing style section is shown, where its stored heading would mislead: the style is learned
 * from the user's email and sent with every request offering Compose or Edit (#301). Display only: the heading
 * in the style document, shared with the other TabMail apps, stays as it is. */
const writingStyleSectionLabels: Readonly<Record<string, string>> = { "General writing style": "General writing style for emails and formal replies" };

/** Personalization's tabs, in order. */
const personalizationTabs = ["Writing style", "Knowledge base", "History"] as const;
type PersonalizationTab = (typeof personalizationTabs)[number];

/** The writing style and the knowledge base (ADR-DESK-063), ports of iOS's Personalization pages,
 * each a tab, with their history the third (owner, 2026-10-28: the page was too long, and the
 * writing style's sections hard to see). The writing style's three sections, each under its own
 * heading, and the knowledge base are lists of bullets to edit, add to and remove from, each text
 * with a reset to its default, confirmed in place; the history lists the newest first, each entry
 * showing what restoring it would change, with Restore, confirmed in place. Every tab stays
 * rendered while another shows, so what is being typed in one is still there on coming back. */
function PersonalizationPane({ state }: { state: SettingsState }) {
  const personalization = state.personalization;
  const [tab, setTab] = useState<PersonalizationTab>("Writing style");
  const [failure, setFailure] = useState<string | null>(null);
  const id = useId();
  const run = async (command: Command) => {
    setFailure(null);
    const { error } = await send(command);
    setFailure(error);
  };
  const panel = (name: PersonalizationTab, children: ReactNode) => (
    // A stop in the Tab order of its own: Tab from the chosen tab reaches its panel even when the
    // panel holds no control (an empty History).
    <div role="tabpanel" id={`${id}-${personalizationTabs.indexOf(name)}`} aria-label={name} tabIndex={0} hidden={tab !== name}>
      {children}
    </div>
  );
  return (
    <>
      <Tabs label="Personalization" id={id} tabs={personalizationTabs} chosen={tab} onChoose={setTab} />
      {panel(
        "Writing style",
        <>
          <TabIntro lines={["How agent mode writes emails and formal replies for you.", "Sent with requests that may write; TabMail doesn’t keep it."]}>
            <ResetButton what="writing style" onReset={() => void run({ type: "resetWritingStyle" })} />
          </TabIntro>
          {personalization.writingStyle.map(({ section, bullets }) => (
            <section key={section} className="card-section">
              <h2 className="section-heading">{writingStyleSectionLabels[section] ?? section}</h2>
              <div className="group">
                <BulletEditor title={writingStyleSectionLabels[section] ?? section} bullets={bullets} onChange={(edited) => run({ type: "editWritingStyle", section, shown: bullets, bullets: edited })} />
              </div>
            </section>
          ))}
        </>,
      )}
      {panel(
        "Knowledge base",
        <>
          <TabIntro lines={["What agent mode knows and remembers about you.", "Sent with each request; TabMail doesn’t keep it."]}>
            <ResetButton what="knowledge base" onReset={() => void run({ type: "resetKnowledgeBase" })} />
          </TabIntro>
          <Group>
            <BulletEditor title="Knowledge base" bullets={personalization.knowledgeBase} onChange={(edited) => run({ type: "editKnowledgeBase", shown: personalization.knowledgeBase, bullets: edited })} />
          </Group>
        </>,
      )}
      {panel(
        "History",
        <>
          <TabIntro lines={[`Your last ${config.promptHistoryMax} changes, kept on this computer so you can put one back.`]} />
          <Group>
            {personalization.history.length === 0 ? (
              <div className="row">
                <span className="caption">No changes yet.</span>
              </div>
            ) : (
              <ul className="dictionary" aria-label="History">
                {personalization.history.map((item) => (
                  <HistoryRow key={item.id} item={item} onRestore={() => void run({ type: "restorePromptHistory", id: item.id })} />
                ))}
              </ul>
            )}
          </Group>
        </>,
      )}
      {failure !== null && (
        <Group>
          <div className="row">
            <span className="error">{failure}</span>
          </div>
        </Group>
      )}
    </>
  );
}

/** A row of tabs, one chosen, as a segmented control: a click or the arrow keys choose another,
 * and Tab moves on into the chosen tab's panel (`id` names the panels by place, `<id>-<index>`: an
 * id holds no spaces). */
function Tabs<Name extends string>({ label, id, tabs, chosen, onChoose }: { label: string; id: string; tabs: readonly Name[]; chosen: Name; onChoose: (tab: Name) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const move = (by: number) => {
    const index = (tabs.indexOf(chosen) + by + tabs.length) % tabs.length;
    onChoose(tabs[index] ?? chosen);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  };
  return (
    <div
      ref={list}
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          move(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      {tabs.map((tab, index) => (
        <button key={tab} role="tab" aria-selected={tab === chosen} aria-controls={`${id}-${index}`} tabIndex={tab === chosen ? 0 : -1} className={tab === chosen ? "tab selected" : "tab"} onClick={() => onChoose(tab)}>
          {tab}
        </button>
      ))}
    </div>
  );
}

/** What a tab holds, said at its top a sentence to a line, with the tab's own action (Reset) beside
 * it, or under it when the action is too wide to share the line (Reset's question). */
function TabIntro({ lines, children }: { lines: string[]; children?: ReactNode }) {
  return (
    <div className="tab-intro">
      <p className="caption">
        {lines.map((line, index) => (
          // Read as one text: a space between lines, which a line's start drops.
          <span key={line}>{index === 0 ? line : ` ${line}`}</span>
        ))}
      </p>
      {children}
    </div>
  );
}

/** Reset, then a question in its place: reset to the default, or not. */
function ResetButton({ what, onReset }: { what: string; onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) return <button onClick={() => setConfirming(true)}>Reset…</button>;
  return (
    <span className="buttons">
      <span className="caption">Reset your {what} to the default? You can restore it from History.</span>
      <button onClick={() => setConfirming(false)}>Cancel</button>
      <button
        className="default"
        onClick={() => {
          setConfirming(false);
          onReset();
        }}
      >
        Reset
      </button>
    </span>
  );
}

/** A list of bullets: each one a field, saved as it is left or Return is pressed, with a remove
 * button; then a field to add one. `onChange` is given the whole list as edited. */
function BulletEditor({ title, bullets, onChange }: { title: string; bullets: string[]; onChange: (bullets: string[]) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() === "") return;
    void onChange([...bullets, draft.trim()]);
    setDraft("");
  };
  return (
    <div className="bullet-editor">
      <ul className="dictionary" aria-label={title}>
        {bullets.map((bullet, index) => (
          // Keyed by the text and how many equal bullets come before it, not by position: a bullet
          // changed elsewhere (a tool) shows afresh, and one added or removed elsewhere
          // leaves the other rows, and what is being typed in them, as they are.
          <BulletRow
            key={`${bullets.slice(0, index).filter((other) => other === bullet).length}:${bullet}`}
            bullet={bullet}
            label={`${title}, item ${index + 1}`}
            onSave={(text) => void onChange(bullets.map((other, at) => (at === index ? text : other)))}
            onRemove={() => void onChange(bullets.filter((_, at) => at !== index))}
          />
        ))}
      </ul>
      <form className="row" onSubmit={add}>
        <input type="text" placeholder="Add an item" aria-label={`Add to ${title}`} maxLength={config.personalizationBulletMaxLength} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" disabled={draft.trim() === ""}>
          Add
        </button>
      </form>
    </div>
  );
}

function BulletRow({ bullet, label, onSave, onRemove }: { bullet: string; label: string; onSave: (text: string) => void; onRemove: () => void }) {
  const [text, setText] = useState(bullet);
  const save = () => {
    // An emptied field removes its bullet, as the store leaves empty ones out. Compared trimmed,
    // so a change of spaces alone saves nothing.
    if (text.trim() !== bullet.trim()) onSave(text.trim());
  };
  return (
    // Saved when focus leaves the row, not the field: a press on the row's own Remove focuses it
    // first, and a save then would replace the row (its key is its text) under the press, losing it.
    <li
      className="row"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) save();
      }}
    >
      {/* A field that wraps and grows with its text, so a long bullet reads whole; a bullet is one
       * line, so Enter saves it rather than breaking it. */}
      <textarea
        className="bullet-text"
        rows={1}
        aria-label={label}
        maxLength={config.personalizationBulletMaxLength}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") setText(bullet);
        }}
      />
      <button className="link" aria-label={`Remove ${label}`} onClick={onRemove}>
        Remove
      </button>
    </li>
  );
}

/** How a history entry came about, as iOS labels it. */
const historySources: Record<PromptHistoryItem["source"], string> = { local_edit: "Edit", reset: "Reset" };

/** One history entry: how and when, what it changed, and, opened, what restoring it would change,
 * with Restore, confirmed in place. */
function HistoryRow({ item, onRestore }: { item: PromptHistoryItem; onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const fields = item.fields.map((field) => (field === "kb" ? "Knowledge base" : "Writing style")).join(", ");
  const unchanged = item.restores.length === 0 && item.removes.length === 0;
  return (
    <li className="row stack">
      <div className="history-heading">
        <span>
          {historySources[item.source]} <span className="caption">{memoryDate(Date.parse(item.timestamp))} · {fields}</span>
        </span>
        <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <>
          {unchanged ? (
            <span className="caption">No items added or removed.</span>
          ) : (
            <ul className="history-changes">
              {item.restores.map((bullet) => (
                <li key={`+${bullet}`} className="history-restores">
                  + {bullet}
                </li>
              ))}
              {item.removes.map((bullet) => (
                <li key={`-${bullet}`} className="history-removes">
                  − {bullet}
                </li>
              ))}
            </ul>
          )}
          {confirming ? (
            <div className="buttons">
              <span className="caption">Put your writing style and knowledge base back as they were then?</span>
              <button onClick={() => setConfirming(false)}>Cancel</button>
              <button
                className="default"
                onClick={() => {
                  setConfirming(false);
                  onRestore();
                }}
              >
                Restore
              </button>
            </div>
          ) : (
            <div className="buttons">
              <button onClick={() => setConfirming(true)}>
                Restore…
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

function PermissionsPane({ state }: { state: SettingsState }) {
  return (
    <>
      <Group>
        <PermissionRow title="Microphone" granted={state.microphoneGranted} onRequest={() => send({ type: "requestMicrophone" })} />
        <PermissionRow title={state.keyboardPermission?.title ?? "Accessibility (hotkey and typing)"} granted={state.accessibilityTrusted} onRequest={() => send({ type: "requestAccessibility" })} />
      </Group>
      {state.gnomeIntegration && (
        <Group captions={[
          state.gnomeIntegration === "ready" ? "Press Space while dictating to switch to agent mode, or Escape to cancel. The pill follows the caret where the app provides its position."
            : state.gnomeIntegration === "restart" ? "Log out of Ubuntu and back in, then choose Enable if needed. GNOME loads newly installed or updated integration at login."
              : state.gnomeIntegration === "unsupported" ? "GNOME integration currently supports GNOME 50. The regular dictation shortcuts remain available."
                : state.gnomeIntegration === "unavailable" ? "GNOME integration could not be enabled. Check GNOME Extensions for an error, then try again."
                : "Enable GNOME integration for Space to switch mode, Escape to cancel, and improved caret placement. The TabMail installer includes it.",
        ]}>
          <div className="row">
            <span>GNOME integration</span>
            {state.gnomeIntegration === "ready" ? <span className="allowed">✓ Enabled</span>
              : <button disabled={state.gnomeIntegration === "checking" || state.gnomeIntegration === "unsupported"} onClick={() => send({ type: "enableGnomeIntegration" })}>Enable</button>}
          </div>
        </Group>
      )}
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
  // Why the update failed, under the card; the button retries.
  return (
    <Group captions={[state.update?.kind === "failed" && state.update.message]}>
      <Toggle label="Open at login" checked={state.openAtLogin} onChange={(value) => send({ type: "setOpenAtLogin", value })} />
      {state.debugAllowed && (
        <Toggle label="Debug mode" checked={state.debugMode} onChange={(value) => send({ type: "setDebugMode", value })}>
          Uses the development server and shows debug items in the menu.
        </Toggle>
      )}
      <div className="row">
        <span>Version</span>
        <span className="value version">{state.version}</span>
      </div>
      {state.update && <UpdateRow update={state.update} />}
    </Group>
  );
}

/** The menu's update item as a button: Check for Updates, what a check is doing, Restart to Update or
 * Install Update, or Retry. */
function UpdateRow({ update }: { update: UpdateState }) {
  const { label, enabled, install } = updateItem(update);
  return (
    <div className="row">
      <span>Updates</span>
      <button disabled={!enabled} onClick={() => void send({ type: install ? "installUpdate" : "checkForUpdates" })}>
        {label}
      </button>
    </div>
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
function Toggle({ label, icon, checked, onChange, extra, children }: { label: string; icon?: ReactNode; checked: boolean; onChange: (value: boolean) => unknown; extra?: ReactNode; children?: ReactNode }) {
  const id = useId();
  return (
    <div className="row toggle">
      <span className="toggle-text">
        <label htmlFor={id} className={icon ? "labeled-icon" : undefined}>
          {icon}
          {label}
        </label>
        {children && <span className="caption">{children}</span>}
        {extra}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(event) => void onChange(event.target.checked)} />
    </div>
  );
}

/** How long a new event lasts when no end is given, under the Calendar switch: Thunderbird's choices,
 * and the one in force if the agent set another (`change_setting`). */
function EventDurationPicker({ state }: { state: SettingsState }) {
  const id = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const choices = config.eventDurationChoices.includes(state.eventDuration) ? config.eventDurationChoices : [...config.eventDurationChoices, state.eventDuration].sort((a, b) => a - b);
  const choose = async (value: number) => {
    setFailure(null);
    const { error } = await send({ type: "setEventDuration", value });
    setFailure(error);
  };
  return (
    <span className="event-duration">
      <label htmlFor={id}>Default event length</label>
      <select id={id} value={state.eventDuration} onChange={(event) => void choose(Number(event.target.value))}>
        {choices.map((minutes) => (
          <option key={minutes} value={minutes}>
            {eventDurationLabel(minutes)}
          </option>
        ))}
      </select>
      {failure && <span className="error">{failure}</span>}
    </span>
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
applyPalette(document);
if (root) createRoot(root).render(<Settings />);
