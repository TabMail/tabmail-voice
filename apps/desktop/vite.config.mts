// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "src/renderer");

/** The renderer's pages, one per window (the overlay, Settings, the welcome wizard, the hidden microphone window, the screen-read debug view). */
export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(root, "overlay.html"),
        settings: resolve(root, "settings.html"),
        welcome: resolve(root, "welcome.html"),
        audio: resolve(root, "audio.html"),
        contextDebug: resolve(root, "context-debug.html"),
      },
    },
  },
});
