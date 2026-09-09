/**
 * E5 — the contract an Indian statutory integration has to satisfy, and the one
 * implementation that exists.
 *
 * ## What this is, plainly
 *
 * **No GSTN, IRP, NIC or Tally connection is wired up.** There is no GSP
 * account, no credential column, no certificate, and nothing in this repository
 * has ever spoken to a government portal. So this is a *boundary*, exercised
 * against a stub, not an integration exercised against a provider — and the only
 * adapter registered at runtime is `STUB_COMPLIANCE_ADAPTER`, whose honest
 * answer to "register this invoice" is "here is a well-formed IRN that no tax
 * authority has ever seen".
 *
 * **This makes no compliance claim.** Nothing here is certified, nothing here
 * has been reviewed against the e-invoicing schema of any particular year, and a
 * stub IRN is not a filing. Turning the flag on with the stub adapter gives an
 * organisation a rehearsal, not a return.
 *
 * The point of writing the boundary before the integration is that the parts
 * which are easy to get wrong — when to call, what to store, what an outage
 * means, and above all what must *not* happen to the stock ledger — are fixed
 * now, while they are cheap, and are the same for every provider. What is left
 * for a real adapter is the genuinely provider-specific part: turning our
 * document into their payload and their response into ours.
 *
 * ## What an adapter may not do
 *
 * An adapter never writes stock, never writes a shipment row, and never posts to
 * the general ledger. It takes a document and returns a *result*, and
 * `IndiaComplianceService` stores it. That is what keeps the unit's hardest
 * requirement true — "flag on + stub: shipment stores an IRN, **ledger
 * unchanged**" — by construction rather than by care: this file cannot reach the
 * stock engine, because it does not import it.
 *
 * ## Why the flags default off
 *
 * An organisation that has not asked for e-invoicing must generate no outbound
 * traffic at all, and must not accumulate documents describing filings it never
 * made. Off is therefore not "the feature is disabled" but "this code path does
 * not run": `IndiaComplianceService` returns a `SKIPPED` result without
 * constructing a payload, so there is nothing to leak and nothing to clean up
 * if the flag is turned on later.
 */

/**
 * The events a successful filing raises, as a declared map rather than a ternary
 * at the call site.
 *
 * `inventory-outbox-coverage.spec.ts` scans for emitted event types statically,
 * and a name computed inside a conditional is invisible to it — which means the
 * publisher would meet an unregistered type at runtime, treat it as an error and
 * retry it to DEAD. The guard caught exactly that here. Declaring the pair keeps
 * both the scanner and a reader able to see what this module can emit.
 */
export const COMPLIANCE_EVENTS = {
  EINVOICE_REGISTERED: "inventory.einvoice.registered",
  EINVOICE_CANCELLED: "inventory.einvoice.cancelled",
  EWAYBILL_GENERATED: "inventory.ewaybill.generated",
} as const;

export const COMPLIANCE_DOCUMENT_KINDS = ["EINVOICE", "EWAYBILL"] as const;
export type ComplianceDocumentKind = (typeof COMPLIANCE_DOCUMENT_KINDS)[number];

/** What we send. Deliberately our vocabulary, not any provider's schema. */
export interface ComplianceRequest {
  readonly kind: ComplianceDocumentKind;
  /** The document this is *about* — a shipment, a sales order. */
  readonly sourceType: string;
  readonly sourceId: string;
  /** Our own document number, which is what a provider echoes back. */
  readonly documentNumber: string;
  /**
   * A digest of the document as it stood when this was requested.
   *
   * Not decoration: a cancel has to prove it is cancelling the thing that was
   * registered, and a re-register after an edit must not silently reuse the
   * first IRN. The hash is what makes both checkable.
   */
  readonly payloadHash: string;
  readonly lines: ReadonlyArray<{
    readonly description: string;
    readonly hsnCode: string | null;
    /** Decimal strings. A quantity that becomes a float on the way to a tax authority is a defect. */
    readonly quantity: string;
    readonly taxableValue: string;
  }>;
}

export type ComplianceResult =
  | {
      readonly status: "REGISTERED";
      /** IRN for an e-invoice, EBN for an e-way bill. */
      readonly externalId: string;
      readonly acknowledgedAt: string;
      /** Whatever the provider actually said, stored verbatim for the audit. */
      readonly raw: Record<string, unknown>;
    }
  | {
      readonly status: "CANCELLED";
      readonly externalId: string;
      readonly acknowledgedAt: string;
      readonly raw: Record<string, unknown>;
    }
  | {
      readonly status: "FAILED";
      /** The provider's own code where there is one — `422`, `2150`, `NO_CREDENTIALS`. */
      readonly code: string;
      readonly message: string;
      /** A failure that will never succeed on retry: a malformed GSTIN, a duplicate IRN. */
      readonly terminal: boolean;
    };

export interface ComplianceAdapter {
  readonly code: string;
  /**
   * Whether this adapter can reach a real authority.
   *
   * `false` is a first-class answer. It is what makes "flag on, stub adapter"
   * distinguishable from "flag on, provider configured" at the call site and in
   * the stored row, so nobody later mistakes a rehearsal for a filing.
   */
  readonly isLive: boolean;
  register(request: ComplianceRequest): Promise<ComplianceResult>;
  cancel(input: {
    readonly kind: ComplianceDocumentKind;
    readonly externalId: string;
    readonly reason: string;
  }): Promise<ComplianceResult>;
}

/**
 * Retry ladder, mirroring `CARRIER_RETRY_SCHEDULE_MS` and for the same reason:
 * this runs inside a request somebody is waiting on, so the whole ladder has to
 * fit in a request budget. A portal still refusing after three attempts is an
 * outage, and dead-lettering is more honest than holding a browser open.
 */
export const COMPLIANCE_RETRY_SCHEDULE_MS: readonly number[] = [300, 900];
export const COMPLIANCE_MAX_ATTEMPTS = COMPLIANCE_RETRY_SCHEDULE_MS.length + 1;
/** A portal that has not answered in ten seconds is not about to. */
export const COMPLIANCE_CALL_TIMEOUT_MS = 10_000;

export function nextComplianceAttemptDelayMs(attempts: number): number | null {
  if (attempts < 1) return 0;
  return COMPLIANCE_RETRY_SCHEDULE_MS[attempts - 1] ?? null;
}

export interface ComplianceAttemptPlan {
  readonly attempts: number;
  readonly retryInMs: number | null;
  readonly deadLettered: boolean;
}

/**
 * The next state of one compliance call, as a value.
 *
 * Pure and separate from the executor, for the reason `planCarrierAttempt`
 * gives: that a failure retries, that the schedule is walked in order, and that
 * it stops being retryable exactly when the schedule runs out are the properties
 * a reader must be able to check, and none is legible spread through the
 * branches of a function that is also doing I/O.
 */
export function planComplianceAttempt(input: {
  readonly attempts: number;
  readonly ok: boolean;
  readonly terminal?: boolean;
}): ComplianceAttemptPlan {
  const attempts = input.attempts + 1;
  if (input.ok) return { attempts, retryInMs: null, deadLettered: false };

  const delay = input.terminal ? null : nextComplianceAttemptDelayMs(attempts);
  if (delay === null || attempts >= COMPLIANCE_MAX_ATTEMPTS) {
    return { attempts, retryInMs: null, deadLettered: true };
  }
  return { attempts, retryInMs: delay, deadLettered: false };
}

/**
 * Walks the ladder `planComplianceAttempt` describes, and bounds each call.
 *
 * The planner decides what should happen next; this is the thing that does it.
 * Without it the schedule, `COMPLIANCE_MAX_ATTEMPTS` and
 * `COMPLIANCE_CALL_TIMEOUT_MS` were exported, unit-tested and called by
 * nothing — a portal that refused once was recorded as failed with no second
 * attempt, and one that never answered left the caller's promise unsettled,
 * because `await adapter.register(...)` has no deadline of its own.
 *
 * A timeout is a transient failure, so it takes the ladder like any other: a
 * portal that is slow now may answer in nine hundred milliseconds, and the
 * whole ladder is sized to fit inside a request budget.
 *
 * `sleep` is a parameter so a test can walk the ladder without waiting for it.
 */
export async function executeComplianceCall(
  call: () => Promise<ComplianceResult>,
  options: {
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ComplianceResult> {
  const timeoutMs = options.timeoutMs ?? COMPLIANCE_CALL_TIMEOUT_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempts = 0;
  let last: ComplianceResult = {
    status: "FAILED",
    code: "NOT_ATTEMPTED",
    message: "no attempt was made",
    terminal: false,
  };

  for (;;) {
    last = await withComplianceTimeout(call, timeoutMs);
    const plan = planComplianceAttempt({
      attempts,
      ok: last.status !== "FAILED",
      terminal: last.status === "FAILED" ? last.terminal : false,
    });
    attempts = plan.attempts;

    if (plan.retryInMs === null) return last;
    await sleep(plan.retryInMs);
  }
}

/**
 * The deadline itself.
 *
 * The losing promise is left to settle on its own — there is no cancellation to
 * hand a provider SDK — so this bounds how long the caller waits, not how long
 * the portal takes.
 */
async function withComplianceTimeout(
  call: () => Promise<ComplianceResult>,
  timeoutMs: number,
): Promise<ComplianceResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ComplianceResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "FAILED",
          code: "TIMEOUT",
          message: `no answer within ${timeoutMs}ms`,
          terminal: false,
        }),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([call(), deadline]);
  } catch (err) {
    // A provider SDK rejects on a socket error the same way it would return a
    // 503. Letting it escape would propagate out of `register` instead of
    // recording a failure, so the outage would reach the caller as a stack
    // trace and leave no document row behind explaining it.
    return {
      status: "FAILED",
      code: "ADAPTER_THREW",
      message: err instanceof Error ? err.message : String(err),
      terminal: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A deterministic, obviously-fake identifier.
 *
 * The `STUB-` prefix is load-bearing. A real IRN is 64 hex characters, and a
 * stub that looked like one would be indistinguishable from a filing in a
 * screenshot, an export or a support conversation — which is exactly the
 * confusion a rehearsal must not create. Derived from the payload hash rather
 * than random so a replayed request yields the same id and the idempotency of
 * the caller is visible in the stored row.
 */
export function stubExternalId(kind: ComplianceDocumentKind, payloadHash: string): string {
  return `STUB-${kind}-${payloadHash.slice(0, 32).toUpperCase()}`;
}

/**
 * The only adapter registered at runtime.
 *
 * It always succeeds, because a stub that failed intermittently would be a
 * simulation of an outage rather than a rehearsal of the happy path, and the
 * outage behaviour is already asserted directly against `planComplianceAttempt`.
 */
export const STUB_COMPLIANCE_ADAPTER: ComplianceAdapter = {
  code: "stub",
  isLive: false,
  async register(request) {
    return {
      status: "REGISTERED",
      externalId: stubExternalId(request.kind, request.payloadHash),
      acknowledgedAt: new Date().toISOString(),
      raw: {
        adapter: "stub",
        note: "No tax authority was contacted. This is a rehearsal, not a filing.",
        documentNumber: request.documentNumber,
        lineCount: request.lines.length,
      },
    };
  },
  async cancel(input) {
    return {
      status: "CANCELLED",
      externalId: input.externalId,
      acknowledgedAt: new Date().toISOString(),
      raw: { adapter: "stub", reason: input.reason },
    };
  },
};

/**
 * A live adapter that refuses, which is the correct behaviour with no
 * credentials.
 *
 * Selecting a provider an organisation has not configured must fail loudly at
 * the first call rather than silently fall back to the stub — a silent fallback
 * is how somebody comes to believe they are filing when they are rehearsing.
 * `terminal: true`, because no number of retries will conjure a GSP account.
 */
export function unconfiguredLiveAdapter(code: string): ComplianceAdapter {
  const refusal = async (): Promise<ComplianceResult> => ({
    status: "FAILED",
    code: "NO_CREDENTIALS",
    message: `The ${code} adapter has no credentials configured. Nothing was sent.`,
    terminal: true,
  });
  return { code, isLive: true, register: refusal, cancel: refusal };
}

/**
 * INV-25 — the stub, refusing, because this process is serving real invoices.
 *
 * `STUB_COMPLIANCE_ADAPTER` mints `STUB-EINVOICE-<hash>` and that string is
 * written to `inv_compliance_documents.external_id`. Nothing about the
 * environment stood between an operator turning on e-invoicing and a document
 * row carrying an invented IRN: the flags are tenant settings, the adapter code
 * is a tenant-writable string, and `stub` is its default. The `STUB-` prefix and
 * the `adapter_is_live` column are honest, but they are labelling, and an
 * identifier that must not be mintable in production must not be mintable in
 * production.
 *
 * So in production the stub becomes a refusal. The result is a queryable
 * `FAILED` compliance document with a null `external_id`, an error code an
 * operator can act on, and an audit row — the same shape a real provider outage
 * produces, which is the shape the rest of this file already handles.
 *
 * `terminal: true`: retrying does not make a tax authority appear.
 */
export function productionBlockedStubAdapter(): ComplianceAdapter {
  const refusal = async (): Promise<ComplianceResult> => ({
    status: "FAILED",
    code: "STUB_ADAPTER_FORBIDDEN_IN_PRODUCTION",
    message:
      "The stub compliance adapter cannot be used in production: it invents an IRN rather than obtaining one. No tax authority was contacted and no identifier was issued. Configure a real GSP/IRP adapter, or leave e-invoicing and e-waybill disabled.",
    terminal: true,
  });
  return { code: "stub", isLive: false, register: refusal, cancel: refusal };
}
