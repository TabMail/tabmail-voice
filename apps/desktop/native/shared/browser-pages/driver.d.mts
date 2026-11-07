// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The types of `driver.mjs`, for the tests that import it.
import type { Readable, Writable } from "node:stream";
import type { Page, Size } from "./document.mjs";

export interface Timing { request: number; page: number; settle: number; retry: number; tries: number; front: number }
export const timing: Timing;
export const fieldMaxLength: number;
export const pages: Page[];
/** A request its helper did not answer in time. */
export class RequestTimeoutError extends Error {}
export interface Helper { child: { kill(): unknown }; request(method: string, params?: object): Promise<unknown> }
export function rpc(name: string, child: { stdin: Writable; stdout: Readable; stderr: Readable; kill(): unknown }, options?: { log?: (line: string) => void; request?: number }): Helper;
export interface Command { kind: "select" | "done"; line?: number; from?: number; to?: number }
export interface PageChannel {
  ask(respond: (command: Command) => void): void;
  report(body: unknown): void;
  deliver(command: Command): void;
  send(command: Command): Promise<unknown>;
  open(): Promise<unknown>;
}
export function pageChannel(options?: { page?: number }): PageChannel;
export interface Helpers { main: Helper; reader: Helper; fieldReader: Helper; shell: Helper | null; stop(): void }
export interface Browser { name: "firefox" | "chrome" | "edge"; path: string }
export function readPages(options: {
  platform: string;
  browsers: Browser[];
  startHelpers: () => Helpers;
  launch: (browser: Browser, url: string) => { activate(): void; close(): Promise<void> };
  channel: PageChannel;
  url: (page: Page, size: Size) => string;
  write: (line: string) => void;
  wait?: (ms: number) => Promise<unknown>;
  times?: Timing;
}): Promise<{ results: { key: string; outcome: "pass" | "fail" | "known" | "fixed" }[]; status: number }>;
