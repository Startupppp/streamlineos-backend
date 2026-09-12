import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * INV-27 — a Shopify that is not Shopify, listening on a port the OS picked.
 *
 * Started inside the test, bound to `127.0.0.1:0` so two suites running at once
 * cannot collide on a port, and torn down in `afterAll`. Nothing here reaches
 * the network: the adapter is pointed at this server by the same
 * `settings.storeUrl` a tenant would use, which means the request shapes, the
 * headers, the pagination and the error handling are all exercised for real
 * rather than mocked at the `fetch` boundary.
 *
 * It records every request it received, which is how the specs assert the two
 * things a mocked `fetch` would let slide: that the access token is actually
 * sent, and that it is sent on the Shopify header rather than as a query
 * parameter where it would end up in somebody's access log.
 */

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly token: string | undefined;
  readonly body: unknown;
}

export interface StubRoute {
  /** Matched against `${method} ${pathname}` with the API prefix stripped. */
  readonly match: string;
  readonly status?: number;
  readonly body?: unknown;
  /** Raw text, for the "answered 200 with something unreadable" case. */
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serve this route only once, then fall through to the next matching one. */
  readonly once?: boolean;
}

export interface ShopifyStub {
  readonly url: string;
  readonly requests: StubRequest[];
  /** Put routes in front of the existing ones — later calls win. */
  route(...routes: StubRoute[]): void;
  close(): Promise<void>;
}

const API_PREFIX = /^\/admin\/api\/[^/]+\//;

export async function startShopifyStub(initial: readonly StubRoute[] = []): Promise<ShopifyStub> {
  const routes: StubRoute[] = [...initial];
  const requests: StubRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://stub");
      const path = url.pathname.replace(API_PREFIX, "");
      const key = `${req.method ?? "GET"} ${path}`;

      requests.push({
        method: req.method ?? "GET",
        path: `${path}${url.search}`,
        token: header(req, "x-shopify-access-token"),
        body: raw.length > 0 ? safeJson(raw) : null,
      });

      const index = routes.findIndex((candidate) => candidate.match === key);
      if (index === -1) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: `stub has no route for ${key}` }));
        return;
      }

      const route = routes[index];
      if (route.once) routes.splice(index, 1);

      res.writeHead(route.status ?? 200, {
        "content-type": "application/json",
        ...(route.headers ?? {}),
      });
      res.end(route.text ?? JSON.stringify(route.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // `address()` is `string | AddressInfo | null`; narrowed rather than asserted,
  // so the day it answers a pipe name this fails loudly instead of reading
  // `undefined` as a port and dialling 0.
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub server did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    route(...added: StubRoute[]) {
      routes.unshift(...added);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `undici` keeps its sockets alive, so `close()` alone waits for them and
        // jest reports a leaked handle after the suite has already passed.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
