// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { contextBridge, ipcRenderer } from "electron";
import type { AudioCommand, AudioReport, Command, CommandResult, VoiceBridge, WindowName, WindowStates } from "../shared/ipc.js";

// A sandboxed preload script can load only Electron's own modules, so the channel names are written
// out here; test/shared/ipc.test.ts checks they are `channels` in src/shared/ipc.ts.
const channels = {
  state: "voice:state",
  getState: "voice:get-state",
  command: "voice:command",
  audioCommand: "voice:audio-command",
  audioReport: "voice:audio-report",
};

const bridge: VoiceBridge = {
  onState<Name extends WindowName>(window: Name, listener: (state: WindowStates[Name]) => void): () => void {
    // The state asked for now is dropped if a pushed one, newer, arrives first.
    let pushed = false;
    let stopped = false;
    const onPush = (_event: Electron.IpcRendererEvent, name: WindowName, state: WindowStates[Name]): void => {
      if (name !== window) return;
      pushed = true;
      listener(state);
    };
    ipcRenderer.on(channels.state, onPush);
    void ipcRenderer.invoke(channels.getState, window).then((state: WindowStates[Name] | null) => {
      if (!pushed && !stopped && state !== null) listener(state);
    });
    return () => {
      stopped = true;
      ipcRenderer.removeListener(channels.state, onPush);
    };
  },
  send(command: Command): Promise<CommandResult> {
    return ipcRenderer.invoke(channels.command, command);
  },
  onAudioCommand(listener: (command: AudioCommand) => void): void {
    ipcRenderer.on(channels.audioCommand, (_event, command: AudioCommand) => listener(command));
  },
  reportAudio(report: AudioReport): void {
    ipcRenderer.send(channels.audioReport, report);
  },
};

contextBridge.exposeInMainWorld("voice", bridge);
