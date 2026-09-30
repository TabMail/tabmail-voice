// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useEffect, useState } from "react";
import type { Command, CommandResult, VoiceBridge, WindowName, WindowStates } from "../../shared/ipc.js";

declare global {
  interface Window {
    /** Exposed by the preload script. */
    voice: VoiceBridge;
  }
}

/** The window's state as the main process pushes it; null until the first arrives. */
export function useWindowState<Name extends WindowName>(name: Name): WindowStates[Name] | null {
  const [state, setState] = useState<WindowStates[Name] | null>(null);
  useEffect(() => window.voice.onState(name, setState), [name]);
  return state;
}

export function send(command: Command): Promise<CommandResult> {
  return window.voice.send(command);
}
