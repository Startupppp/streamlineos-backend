/**
 * How many reverse proxies sit in front of this process — declared, never guessed.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `extractClientIp` and `resolveClientIp` both read
 * the forwarded-for header and took `split(",")[0]` — the LEFTMOST hop. A proxy APPENDS its peer
 * to that header, so the leftmost entry is whatever the client sent; every hop to the right
 * of it was written by infrastructure. Keying a rate limiter on the leftmost entry therefore
 * keys it on a value the attacker chooses: 150 unauthenticated requests with a rotating first
 * hop produced 150 distinct buckets and 0 blocked, against 120 blocked from a fixed one.
 * Every unauthenticated tier — magic-link issuance, password reset, public form submission —
 * was defeated by one header.
 *
 * THE FIX is to stop reading the header in application code at all and let Express resolve
 * `req.ip` under a declared `trust proxy`. With N trusted hops Express walks the header from
 * the RIGHT and returns the first address outside the trusted set, so prepending entries
 * cannot move the answer. With `trust proxy` false it returns the socket address, which the
 * client cannot influence at all.
 *
 * THE DEFAULT IS `false`, i.e. the header is ignored entirely. That is deliberate and it is
 * the fail-CLOSED direction for a limiter: behind an undeclared proxy every caller collapses
 * into one bucket and gets limited too aggressively, which costs availability, whereas
 * trusting an undeclared header costs the limiter altogether. A deployment that really has
 * proxies declares how many with `TRUST_PROXY_HOPS`.
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0)
    throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer, received "${raw}"`);
  return hops;
}

/** The value handed to `app.set("trust proxy", …)`: a hop count, or `false` for none. */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): number | false {
  const hops = trustProxyHops(env);
  return hops === 0 ? false : hops;
}
