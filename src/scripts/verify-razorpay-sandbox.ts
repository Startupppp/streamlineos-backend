/**
 * verify-razorpay-sandbox.ts — the live half of the Razorpay failure/recovery proof.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST
 *   It needs real test-mode credentials and a reachable api.razorpay.com. As a jest
 *   suite it could only ever be a conditional skip, and a skipped test reads as a pass
 *   in every summary that matters. `check:test-suppressions` caps that class for
 *   exactly this reason. Here, an absent prerequisite is exit 2 (INCONCLUSIVE) with the
 *   reason printed, which is not a green.
 *
 * SAFETY
 *   Refuses any RAZORPAY_KEY_ID that does not begin `rzp_test_`, before a socket is
 *   opened. This repo has already had a suite send 14 real emails because dotenv handed
 *   it a live token; the same mistake against a payment provider is worse.
 *
 * WHAT IT PROVES
 *   1. A wrong key secret is surfaced as the repo's own BadGatewayException, not as a
 *      provider error object and not as a 500.
 *   2. An invalid order payload maps the same way.
 *   3. A 4xx is TERMINAL: `classifyRazorpayError` returns "terminal" for
 *      RazorpayClientError, so `callProvider` stops after one attempt instead of
 *      spending its 3-attempt budget. Measured as elapsed wall-clock well under the
 *      3 x 10s ceiling a retry loop would cost.
 *
 * WHAT IT DOES NOT PROVE, deliberately
 *   Recovery from a 5xx. Razorpay's sandbox cannot be made to return one on demand, and
 *   a POST /v1/orders retried without an idempotency mechanism can leave a duplicate
 *   ORDER (not a duplicate charge -- an order is an intent). The `receipt` is computed
 *   by the caller before the call, so retries reuse it and duplicates stay reconcilable.
 *   Closing that properly needs a verified answer about Razorpay's idempotency support,
 *   not an invented header, so it is named here rather than asserted anywhere.
 *
 *   pnpm verify:razorpay-sandbox
 *   pnpm verify:razorpay-sandbox:self-test
 *
 * Exit codes
 *   0  every mapping held · 1  a mapping failed · 2  refused or prerequisite absent
 */
import { BadGatewayException } from "@nestjs/common";

import { RazorpayAdapter } from "../modules/billing/payments/adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "../modules/billing/payments/payment-provider-adapter.interface";

const SELF_TEST = process.argv.includes("--self-test");
const TEST_PREFIX = "rzp_test_";
const RETRY_CEILING_MS = 15_000;

export type KeyVerdict =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly because: string };

/** The whole safety story, in one pure function so the self-test can prove it bites. */
export function checkKey(keyId: string): KeyVerdict {
  if (keyId.length === 0) return { ok: false, because: "RAZORPAY_KEY_ID is not set" };
  if (!keyId.startsWith(TEST_PREFIX))
    return {
      ok: false,
      because: `RAZORPAY_KEY_ID begins "${keyId.slice(0, 9)}", not "${TEST_PREFIX}" — refusing to call a live key`,
    };
  return { ok: true, keyId };
}

export function isTerminalElapsed(elapsedMs: number): boolean {
  return elapsedMs < RETRY_CEILING_MS;
}

function runtimeFor(keyId: string, secret: string, webhookSecret: string) {
  const registry = new PaymentProviderAdapterRegistry();
  return new RazorpayAdapter(registry).configure({ keyId, secret, webhookSecret });
}

interface Probe {
  readonly name: string;
  readonly run: () => Promise<void>;
}

async function expectBadGateway(name: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error: unknown) {
    if (error instanceof BadGatewayException) return;
    throw new Error(
      `${name}: expected BadGatewayException, got ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`,
    );
  }
  throw new Error(`${name}: the call SUCCEEDED; it was supposed to fail`);
}

function selfTest(): void {
  const live = checkKey("rzp_live_abc123");
  const checks: [string, unknown, unknown][] = [
    ["an empty key is refused", checkKey("").ok, false],
    ["a live key is refused", live.ok, false],
    ["the refusal names the prefix it saw", live.ok ? false : live.because.includes("rzp_live_"), true],
    ["a test key is accepted", checkKey("rzp_test_abc123").ok, true],
    ["a near-miss prefix is refused", checkKey("rzp_tes_abc123").ok, false],
    ["one fast attempt reads as terminal", isTerminalElapsed(400), true],
    ["a full retry budget does not", isTerminalElapsed(31_000), false],
  ];
  let failed = 0;
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} self-tests passed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (SELF_TEST) return selfTest();

  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const secret = process.env.RAZORPAY_KEY_SECRET ?? "";
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

  const verdict = checkKey(keyId);
  if (!verdict.ok) {
    console.error(`verify-razorpay-sandbox: INCONCLUSIVE — ${verdict.because}.`);
    console.error("Nothing was called. This is not a pass.");
    process.exit(2);
  }
  if (secret.length === 0 || webhookSecret.length === 0) {
    console.error(
      "verify-razorpay-sandbox: INCONCLUSIVE — RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are both required.",
    );
    process.exit(2);
  }

  console.log(`Target        api.razorpay.com (key ${keyId.slice(0, TEST_PREFIX.length)}…, test mode)`);

  const probes: Probe[] = [
    {
      name: "a wrong key secret maps to BadGatewayException",
      run: () =>
        expectBadGateway("wrong key secret", () =>
          runtimeFor(keyId, "wrong-secret-intentionally-bad", webhookSecret).createOrder({
            amount: "100",
            currency: "INR",
            receipt: "probe-auth-fail",
          }),
        ),
    },
    {
      name: "an invalid order payload maps to BadGatewayException",
      run: () =>
        expectBadGateway("invalid payload", () =>
          runtimeFor(keyId, secret, webhookSecret).createOrder({
            amount: "-1",
            currency: "FAKE_CCY",
            receipt: "probe-bad-payload",
          }),
        ),
    },
    {
      name: "a 4xx is terminal — one attempt, not the 3-attempt retry budget",
      run: async () => {
        const started = Date.now();
        await expectBadGateway("terminal 4xx", () =>
          runtimeFor(keyId, "wrong-secret-no-retry-proof", webhookSecret).createOrder({
            amount: "100",
            currency: "INR",
            receipt: "probe-retry-check",
          }),
        );
        const elapsed = Date.now() - started;
        if (!isTerminalElapsed(elapsed))
          throw new Error(
            `terminal 4xx: took ${String(elapsed)}ms, at or over the ${String(RETRY_CEILING_MS)}ms ceiling — it retried`,
          );
        console.log(`               (elapsed ${String(elapsed)}ms)`);
      },
    },
  ];

  const failures: string[] = [];
  for (const probe of probes) {
    try {
      await probe.run();
      console.log(`  PASS  ${probe.name}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
        console.error(
          `verify-razorpay-sandbox: INCONCLUSIVE — api.razorpay.com is unreachable (${message}). Nothing was proved.`,
        );
        process.exit(2);
      }
      failures.push(`  FAIL  ${probe.name}\n        ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAIL — ${String(failures.length)} of ${String(probes.length)} probe(s) did not hold:`);
    for (const line of failures) console.error(line);
    process.exit(1);
  }
  console.log(`\nOK — all ${String(probes.length)} sandbox failure mappings held.`);
}

void main();
