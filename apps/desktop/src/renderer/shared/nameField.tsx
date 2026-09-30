// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useState } from "react";
import * as config from "../../core/config.js";
import { send } from "./bridge.js";

/** The user's name for agent mode, stored as typed (`setUserName`). It shows `initial` until the user
 * types: the stored name, or in the welcome wizard the suggested one while none is stored, which can
 * arrive after the window opens. */
export function NameField({ initial, placeholder }: { initial: string; placeholder: string }) {
  const [edited, setEdited] = useState<string | null>(null);
  return (
    <input
      type="text"
      className="name-field"
      aria-label="Your name"
      autoComplete="name"
      maxLength={config.userNameMaxLength}
      placeholder={placeholder}
      value={edited ?? initial}
      onChange={(event) => {
        setEdited(event.target.value);
        void send({ type: "setUserName", value: event.target.value });
      }}
    />
  );
}
