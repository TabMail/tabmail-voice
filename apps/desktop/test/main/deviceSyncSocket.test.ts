// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "vitest";
import { deviceSyncSocket, type WebSocketLike } from "../../src/main/deviceSyncSocket.js";

/** A WebSocket the test drives: what it was sent, how often it was closed, and its events to fire. */
class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closes = 0;
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closes += 1;
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function opened(): { socket: FakeWebSocket; url: string; messages: string[]; closes: number[]; sync: ReturnType<ReturnType<typeof deviceSyncSocket>> } {
  let made: { socket: FakeWebSocket; url: string } | null = null;
  const open = deviceSyncSocket((url) => {
    made = { socket: new FakeWebSocket(), url };
    return made.socket;
  });
  const messages: string[] = [];
  const closes: number[] = [];
  const sync = open("wss://relay.example.com/ws?token=example", { message: (text) => messages.push(text), closed: (code) => closes.push(code) });
  if (made === null) throw new Error("no socket");
  const { socket, url } = made;
  return { socket, url, messages, closes, sync };
}

test("opens the address given, sends, and hands on each text message, nothing else", () => {
  const { socket, url, messages, sync } = opened();
  sync.send('{"type":"ping"}');
  socket.fire("message", { data: '{"type":"pong"}' });
  socket.fire("message", { data: new ArrayBuffer(4) });

  expect(url).toBe("wss://relay.example.com/ws?token=example");
  expect(socket.sent).toEqual(['{"type":"ping"}']);
  expect(messages).toEqual(['{"type":"pong"}']);
});

test("the relay's close is told once, with its code", () => {
  const { socket, closes } = opened();
  socket.fire("close", { code: 4001 });
  socket.fire("close", { code: 1000 });

  expect(closes).toEqual([4001]);
});

test("a failed connection is told as 1006, once, and closed; nothing after it is handed on", () => {
  const { socket, messages, closes } = opened();
  socket.fire("error");
  socket.fire("close", { code: 1006 });
  socket.fire("message", { data: '{"type":"connected"}' });

  expect(closes).toEqual([1006]);
  expect(socket.closes).toBe(1);
  expect(messages).toEqual([]);
});

test("closed by the app, it tells nothing more", () => {
  const { socket, messages, closes, sync } = opened();
  sync.close();
  socket.fire("close", { code: 1000 });
  socket.fire("message", { data: '{"type":"connected"}' });

  expect(socket.closes).toBe(1);
  expect([closes, messages]).toEqual([[], []]);
});
