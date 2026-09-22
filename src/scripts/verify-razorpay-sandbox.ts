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
 *   3. A real provider 4xx maps to BadGatewayException after exactly one transport
 *      attempt. Attempts and response status are observed directly.
 *
 * WHAT IT DOES NOT PROVE, deliberately
 *   Recovery from a 5xx. Razorpay's sandbox cannot be made to return one on demand.
 *   Order creation now makes one attempt because an ambiguous failure may already
 *   have created an order. Controlled transport tests prove this failure behavior;
 *   they do not establish live provider idempotency or reconciliation.
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
import { outboundRequest } from "../common/http/outbound-request";
import type { RazorpayTransport } from "../modules/billing/payments/adapters/razorpay.adapter";

const SELF_TEST = process.argv.includes("--self-test");
const TEST_PREFIX = "rzp_test_";

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

function runtimeFor(keyId: string, secret: string, webhookSecret: string, transport?: RazorpayTransport) {
  const registry = new PaymentProviderAdapterRegistry();
  return new RazorpayAdapter(registry, { transport }).configure({ keyId, secret, webhookSecret });
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
      { cause: error }
    );
  }
  throw new Error(`${name}: the call SUCCEEDED; it was supposed to fail`);
}

async function expectProvider4xx(
  name: string,
  call: (transport: RazorpayTransport) => Promise<unknown>,
  expectedStatus?: number,
): Promise<void> {
  let attempts = 0;
  const responseStatuses: number[] = [];
  const transport: RazorpayTransport = async (url, init) => {
    attempts += 1;
    const response = await outboundRequest(url, init);
    responseStatuses.push(response.status);
    return response;
  };
  await expectBadGateway(name, () => call(transport));
  if (responseStatuses.length === 0)
    throw new Error(`${name}: fetch failed to yield a provider HTTP response; mapping is unproved`);
  const status = responseStatuses[0];
  if (attempts !== 1 || responseStatuses.length !== 1 || status < 400 || status >= 500 || (expectedStatus !== undefined && status !== expectedStatus))
    throw new Error(
      `${name}: expected one attempt and provider HTTP ${expectedStatus ?? "4xx"}; observed ${String(attempts)} attempt(s), statuses ${JSON.stringify(responseStatuses)}`,
    );
  console.log(`               (attempts ${String(attempts)}, HTTP ${String(status)})`);
}

function selfTest(): void {
  const live = checkKey("rzp_live_abc123");
  const checks: [string, unknown, unknown][] = [
    ["an empty key is refused", checkKey("").ok, false],
    ["a live key is refused", live.ok, false],
    ["the refusal names the prefix it saw", live.ok ? false : live.because.includes("rzp_live_"), true],
    ["a test key is accepted", checkKey("rzp_test_abc123").ok, true],
    ["a near-miss prefix is refused", checkKey("rzp_tes_abc123").ok, false],
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
        expectProvider4xx("wrong key secret", (transport) =>
          runtimeFor(keyId, "wrong-secret-intentionally-bad", webhookSecret, transport).createOrder({
            amount: "100",
            currency: "INR",
            receipt: "probe-auth-fail",
          }),
        ),
    },
    {
      name: "an invalid order payload maps to BadGatewayException",
      run: () =>
        expectProvider4xx("invalid payload", (transport) =>
          runtimeFor(keyId, secret, webhookSecret, transport).createOrder({
            amount: "-1",
            currency: "FAKE_CCY",
            receipt: "probe-bad-payload",
          }),
          400,
        ),
    },
    {
      name: "a provider 4xx maps to BadGatewayException after exactly one observed attempt",
      run: () =>
        expectProvider4xx("terminal 4xx", (transport) =>
          runtimeFor(keyId, "wrong-secret-no-retry-proof", webhookSecret, transport).createOrder({
            amount: "100",
            currency: "INR",
            receipt: "probe-retry-check",
          }),
        ),
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
