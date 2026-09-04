const MAX_STORED_IP_LENGTH = 100;

/**
 * Everything these two need. Deliberately NOT `express.Request`: eleven controllers
 * declared their own `{ ip?: string; headers: Record<string, string> }` shape and rolled
 * their own header read rather than depend on the express type, and this is the seam that
 * lets every one of them call in.
 */
export type ClientAddressed = { readonly ip?: string | undefined };

/**
 * The caller's address, as EXPRESS resolved it — never as the caller declared it.
 *
 * This used to read the forwarded-for header and take `split(",")[0]`. A proxy APPENDS to that
 * header, so the leftmost entry is the one the client wrote: it keyed every rate limit,
 * abuse counter and audit record in this repository on an attacker-chosen string. Measured
 * against the real guard and service, 150 unauthenticated requests rotating that first hop
 * were blocked 0 times, where 150 from a fixed hop were blocked 120 times.
 *
 * `req.ip` is resolved by Express under the `trust proxy` setting declared in
 * `trust-proxy.ts` and applied in `main.ts`. Express walks the header from the RIGHT past
 * the declared number of trusted hops, so prepended entries cannot move the answer, and with
 * no proxies declared it returns the socket address. Do not reintroduce a header read here:
 * `client-ip-forgery.spec.ts` fails if either function mentions the header.
 */
export function resolveClientIp(req: ClientAddressed): string | undefined {
  const candidate = req.ip;
  return candidate ? candidate.slice(0, MAX_STORED_IP_LENGTH) : undefined;
}

export function resolveClientIpOr(req: ClientAddressed, fallback: string): string {
  return resolveClientIp(req) ?? fallback;
}
