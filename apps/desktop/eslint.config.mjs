// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const requestRule = "A request to TabMail's servers goes through liveTransport (src/core/backend/http.ts), which never follows a redirect. A fetch of anything else is listed in eslint.config.mjs with its reason.";

export default tseslint.config(
  // The browser test pages' CodeMirror bundle is generated (scripts/browser-pages.mts).
  { ignores: ["dist/**", "release/**", "native/**/build/**", "node_modules/**", "native/shared/browser-pages/codemirror.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Raw console bypasses the debug gate (root CLAUDE.md rule 12): log through core/log.
      "no-console": "error",
    },
  },
  {
    // A request to TabMail's servers goes through `liveTransport` (src/core/backend/http.ts), which
    // never follows a redirect: the requests carry the access token or the refresh token.
    files: ["src/**"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: requestRule }],
      "no-restricted-properties": [
        "error",
        ...["globalThis", "window", "self"].map((object) => ({ object, property: "fetch", message: requestRule })),
        ...["fetch", "request"].map((property) => ({ object: "net", property, message: requestRule })),
      ],
    },
  },
  {
    // The only direct fetches: the transport itself; `web_read`, which reads any web page and follows
    // its redirects, with no token (ADR-DESK-030); the PDF reader's stand-in that refuses the network.
    files: ["src/core/backend/http.ts", "src/core/agent/connectors/web.ts", "src/main/documents/pdfWorker.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
);
