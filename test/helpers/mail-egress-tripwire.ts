import http from "node:http";
import https from "node:https";

/**
 * The hosts the two configured providers actually talk to.
 *
 * `resend` (SDK v6) sends over `fetch`; `zeptomail` uses `https.request`. Both
 * are patched, because "the SDK we use today speaks fetch" is not a property
 * worth resting a no-egress claim on.
 */
const MAIL_HOSTS = /(?:^|\.)(?:resend\.com|zeptomail\.(?:in|com|eu))$/i;

export interface MailEgressTripwire {
  /** Mail-provider hosts something tried to reach while armed. Empty is the pass. */
  readonly attempts: readonly string[];
  disarm(): void;
}

function hostOf(value: unknown): string | undefined {
  try {
    if (typeof value === "string") return new URL(value).hostname;
    if (value instanceof URL) return value.hostname;
    if (value && typeof value === "object") {
      const req = value as { url?: string; hostname?: string; host?: string };
      if (typeof req.url === "string") return new URL(req.url).hostname;
      if (typeof req.hostname === "string") return req.hostname;
      if (typeof req.host === "string") return req.host.split(":")[0];
    }
  } catch {
    /* not a URL — not a mail host either */
  }
  return undefined;
}

/**
 * The live tripwire, or null while disarmed.
 *
 * Process-wide rather than per-call because `jest-e2e-seeded.json` arms it once
 * for every seeded file through `setupFiles`, and a spec that wants to read
 * `attempts` must see that same instance rather than install a second layer of
 * patches over the first.
 */
let armed: MailEgressTripwire | null = null;

/**
 * The tripwire armed for this test file.
 *
 * Throws rather than returning null when nothing is armed: a spec asserting
 * "no provider was reached" against an absent tripwire would pass for the one
 * reason that makes the assertion worthless.
 */
export function mailEgressTripwire(): MailEgressTripwire {
  if (!armed) {
    throw new Error(
      "mail egress tripwire is not armed — `test/helpers/arm-mail-egress.setup.ts` " +
        "should be in `setupFiles` in jest-e2e-seeded.json.",
    );
  }
  return armed;
}

/**
 * Fail loudly if anything tries to reach a mail provider.
 *
 * The seeded harness overrides `EmailProviderService`, so nothing should. This
 * exists because "we saw no provider call" is otherwise unfalsifiable — an
 * assertion that passes identically whether the override works or whether the
 * suite simply never sent anything. Armed, the negative means something: the
 * accompanying control test drives a deliberate call at a provider host and
 * requires it to throw, which is what makes the zero credible.
 *
 * It BLOCKS rather than merely records, so a future mail path that bypasses
 * `EmailProviderService` (a service constructing its own client, a new SDK)
 * fails the suite instead of quietly spending live quota. Only provider hosts
 * are intercepted; every other request is passed straight through untouched.
 */
export function armMailEgressTripwire(): MailEgressTripwire {
  /** Idempotent: arming twice would patch the patches and leak the originals. */
  if (armed) return armed;

  const attempts: string[] = [];

  const trip = (host: string): Error => {
    attempts.push(host);
    return new Error(
      `mail egress blocked: something tried to reach ${host} from a seeded e2e run. ` +
        `The harness overrides EmailProviderService, so this is a mail path that ` +
        `bypasses it — find it rather than relaxing this tripwire.`,
    );
  };

  const realFetch = globalThis.fetch;
  const realHttpsRequest = https.request;
  const realHttpRequest = http.request;
  const realHttpsGet = https.get;
  const realHttpGet = http.get;

  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const host = hostOf(input);
    if (host && MAIL_HOSTS.test(host)) return Promise.reject(trip(host));
    return (realFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as typeof globalThis.fetch;

  /**
   * `http.request`/`get` are heavily overloaded — (url, cb), (url, opts, cb),
   * (opts, cb) — so the host may be in either of the first two arguments, and
   * the wrapper is typed through a single call signature rather than trying to
   * reproduce the overload set.
   */
  type AnyRequest = (...args: unknown[]) => unknown;
  const guard =
    (real: AnyRequest): AnyRequest =>
    (...args: unknown[]) => {
      const host = hostOf(args[0]) ?? hostOf(args[1]);
      if (host && MAIL_HOSTS.test(host)) throw trip(host);
      return real(...args);
    };
  const wrap = <T>(real: T): T => guard(real as AnyRequest) as unknown as T;

  https.request = wrap(realHttpsRequest);
  http.request = wrap(realHttpRequest);
  https.get = wrap(realHttpsGet);
  http.get = wrap(realHttpGet);

  armed = {
    attempts,
    disarm() {
      globalThis.fetch = realFetch;
      https.request = realHttpsRequest;
      http.request = realHttpRequest;
      https.get = realHttpsGet;
      http.get = realHttpGet;
      armed = null;
    },
  };
  return armed;
}
