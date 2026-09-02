/**
 * `common/observability/seam-budgets.ts` covers nine infrastructure seams and
 * deliberately carries no AI entry — `ai-metric-alert-parity.spec.ts` asserts
 * that the AI span is never bucketed into a seam budget, because the AI call's
 * dominant cost is a third party's and averaging it into a database seam would
 * make every seam alert meaningless.
 *
 * A streaming AI surface still owes the user two numbers, so they are declared
 * here, in the module that owns them, in the same shape and with the same 25%
 * alert headroom the seam table uses.
 */
export type AiStreamBudgetKey = "ai.stream.first-byte.app" | "ai.stream.dispatch.overhead";

export interface AiStreamBudget {
  readonly key: AiStreamBudgetKey;
  readonly budgetMs: number;
  readonly thresholdMs: number;
  readonly reason: string;
}

export const AI_STREAM_BUDGETS: Readonly<Record<AiStreamBudgetKey, AiStreamBudget>> = {
  "ai.stream.first-byte.app": {
    key: "ai.stream.first-byte.app",
    budgetMs: 150,
    thresholdMs: 112,
    reason:
      "The application's own share of time-to-first-visible-token: request arrival to the first byte on the socket, with the provider's first chunk already available. A streamed answer is a browser-visible read, so it is held to the same 150 ms p95 as route.cached.read; the provider's own latency is not ours and is excluded from this budget rather than hidden inside it. Threshold is 25% below budget.",
  },
  "ai.stream.dispatch.overhead": {
    key: "ai.stream.dispatch.overhead",
    budgetMs: 50,
    thresholdMs: 37,
    reason:
      "Everything this process does between the handler starting and the provider stream being opened: breaker check, redaction, concurrency slot, credit reservation, model resolution. Derived as one cache.roundtrip (2 ms) plus one db.roundtrip.simple for the reservation (20 ms) plus in-process work, and capped at one third of the 150 ms first-byte budget so dispatch overhead alone can never make the visible target unattainable — the same derivation runtime.eventloop.delay uses. Threshold is 25% below budget.",
  },
} as const;

/**
 * The I/O legs of dispatch overhead that are measured by their own seam budgets
 * rather than by an AI test: a stubbed ledger and breaker cost nothing, so an
 * in-process measurement must add these back before it is compared to budget.
 */
export const AI_DISPATCH_IO_ALLOWANCE_MS = 22;

export function getAiStreamBudget(key: AiStreamBudgetKey): AiStreamBudget {
  return AI_STREAM_BUDGETS[key];
}
