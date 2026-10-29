// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { OpenSyncSocket } from "../core/sync/deviceSync.js";

/** The close code of a connection that failed or dropped without a close from the relay. */
const failedCode = 1006;

/** The part of a WebSocket the transport uses. */
export interface WebSocketLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  send(text: string): void;
  close(): void;
}

/** `DeviceSync`'s transport: the relay's WebSocket, Node's own. Each text message is handed on, and
 * the close told once, with its code, or 1006 when the connection failed. The address holds the
 * access token: nothing here logs it, or the socket's errors, which may name it. */
export function deviceSyncSocket(create: (url: string) => WebSocketLike = (url) => new WebSocket(url)): OpenSyncSocket {
  return (url, events) => {
    const socket = create(url);
    let closed = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      events.closed(code);
    };
    socket.addEventListener("message", (event) => {
      if (!closed && typeof event.data === "string") events.message(event.data);
    });
    socket.addEventListener("close", (event) => close(event.code));
    socket.addEventListener("error", () => {
      close(failedCode);
      socket.close();
    });
    return {
      send: (text) => socket.send(text),
      close: () => {
        closed = true;
        socket.close();
      },
    };
  };
}
