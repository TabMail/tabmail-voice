// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The preview's stand-in for the app's preload: the window's state comes from the command line,
// and commands go nowhere.
const prefix = "--preview-state=";
const argument = process.argv.find((value) => value.startsWith(prefix));
const state = JSON.parse(decodeURIComponent(argument.slice(prefix.length)));
window.voice = {
  onState(_name, listener) {
    listener(state);
    return () => {};
  },
  send: async () => ({ error: null }),
  onAudioCommand() {},
  reportAudio() {},
};
