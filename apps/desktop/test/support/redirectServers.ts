// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request one of the servers was sent. `upgrade` is its `Upgrade` header: `websocket` for a
 * WebSocket's opening request. */
export interface SeenRequest {
  method: string;
  url: string;
  body: string;
  authorization: string | undefined;
  upgrade: string | undefined;
}

/** Two servers on the loopback interface (never the network). The first answers every request with
 * `status` and a `Location` on the second, or, with `sameOrigin`, a relative `Location` on itself
 * (`/elsewhere`); after `redirects` requests (if given) it answers 200 itself. The redirect's target
 * answers 200, as the second server does any request. Every answer, the redirect included, carries
 * `body` ("landed" unless given). `asked` is what reached the first server, `reached` what reached
 * the redirect's target. Neither server listens for upgrades, so a WebSocket's opening request gets
 * the same answer that plain fetch follows. */
export interface RedirectServers {
  firstOrigin: string;
  firstURL: string;
  secondOrigin: string;
  asked: SeenRequest[];
  reached: SeenRequest[];
  close(): Promise<void>;
}

const target = "/elsewhere";

export async function redirectServers(status: number, options: { sameOrigin?: boolean; body?: string; redirects?: number } = {}): Promise<RedirectServers> {
  const body = options.body ?? "landed";
  const asked: SeenRequest[] = [];
  const reached: SeenRequest[] = [];
  const landed = (seen: SeenRequest, response: ServerResponse) => {
    reached.push(seen);
    response.end(body);
  };
  const second = recording(landed);
  const secondOrigin = await listen(second);
  const location = options.sameOrigin ? target : `${secondOrigin}${target}`;
  const first = recording((seen, response) => {
    if (options.sameOrigin && seen.url === target) {
      landed(seen, response);
      return;
    }
    asked.push(seen);
    if (options.redirects === undefined || asked.length <= options.redirects) response.writeHead(status, { Location: location });
    response.end(body);
  });
  let firstOrigin: string;
  try {
    firstOrigin = await listen(first);
  } catch (error) {
    await stop(second);
    throw error;
  }
  const close = async () => {
    await Promise.all([first, second].map(stop));
  };
  return { firstOrigin, firstURL: `${firstOrigin}/start`, secondOrigin, asked, reached, close };
}

function recording(answer: (seen: SeenRequest, response: ServerResponse) => void): Server {
  return createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const seen = { method: request.method ?? "", url: request.url ?? "", body, authorization: request.headers.authorization, upgrade: request.headers.upgrade };
      answer(seen, response);
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
