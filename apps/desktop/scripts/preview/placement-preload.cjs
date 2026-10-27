// Offscreen placement smoke test only: no helpers, account or network access.
let listener;
window.voice = {
  onState(_name, next) { listener = next; window.placementReady = true; return () => {}; },
  send: async () => ({ error: null }), onAudioCommand() {}, reportAudio() {},
};
window.setPlacementState = (state) => listener(state);
