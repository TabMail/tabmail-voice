// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** A request one of the servers was sent. A WebSocket's opening request is `upgrade`, with no body. */
export interface SeenRequest {
  method: string;
  url: string;
  body: string;
  authorization: string | undefined;
  upgrade: boolean;
}

/** Two servers on the loopback interface (never the network). The first answers every request, a
 * WebSocket's opening request included, with `status` and a `Location` on the second; the second
 * answers 200 "landed". Each records what reached it. */
export interface RedirectServers {
  firstOrigin: string;
  firstURL: string;
  asked: SeenRequest[];
  reached: SeenRequest[];
  close(): Promise<void>;
}

export async function redirectServers(status: number): Promise<RedirectServers> {
  const asked: SeenRequest[] = [];
  const reached: SeenRequest[] = [];
  const second = recording(reached, (_, response) => response.end("landed"), (socket) => socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"));
  const secondOrigin = await listen(second);
  const location = `${secondOrigin}/elsewhere`;
  const first = recording(
    asked,
    (_, response) => {
      response.writeHead(status, { Location: location });
      response.end();
    },
    (socket) => socket.end(`HTTP/1.1 ${status} Redirect\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`),
  );
  const firstOrigin = await listen(first);
  const close = async () => {
    await Promise.all([first, second].map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }));
  };
  return { firstOrigin, firstURL: `${firstOrigin}/start`, asked, reached, close };
}

function recording(
  list: SeenRequest[],
  answer: (request: IncomingMessage, response: ServerResponse) => void,
  answerUpgrade: (socket: Duplex) => void,
): Server {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      list.push(seen(request, body, false));
      answer(request, response);
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    list.push(seen(request, "", true));
    answerUpgrade(socket);
  });
  return server;
}

function seen(request: IncomingMessage, body: string, upgrade: boolean): SeenRequest {
  return { method: request.method ?? "", url: request.url ?? "", body, authorization: request.headers.authorization, upgrade };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
