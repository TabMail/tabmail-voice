// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The types of `harness.mjs`, for the tests that import it.
export interface CaretRect { x: number; y: number; height: number }
export interface Editor {
  select(line: number, from: number, to: number): void;
  caret(): CaretRect;
  start(): CaretRect;
  selected(): string;
}
export function serve(editor: Editor): Promise<void>;
