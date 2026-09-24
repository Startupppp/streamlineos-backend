import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { startSpan, type OpenSpan } from "../../../../common/observability";

export const KB_ASK_SPAN_NAME = "kb.ask.operation";

export const KB_ASK_OUTCOMES = [
  "answered",
  "no_context",
  "degraded",
  "credits_exhausted",
  "provider_unavailable",
  "error",
] as const;

export type KbAskOutcome = (typeof KB_ASK_OUTCOMES)[number];

const NON_FAULT_ASK_OUTCOMES: ReadonlySet<KbAskOutcome> = new Set<KbAskOutcome>([
  "answered",
  "no_context",
  "degraded",
]);

export function isKbAskFault(outcome: KbAskOutcome): boolean {
  return !NON_FAULT_ASK_OUTCOMES.has(outcome);
}

export function kbAskOutcomeForError(error: unknown): KbAskOutcome {
  if (error instanceof InsufficientAiCreditsException) return "credits_exhausted";
  return "error";
}

export interface KbAskFacts {
  citations?: number;
  candidates?: number;
  degraded?: boolean;
}

export class KbAskMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private finished = false;

  private constructor(orgId: string) {
    if (orgId) this.attributes["org.id"] = orgId;
    this.span = startSpan(KB_ASK_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: { orgId: string }): KbAskMetrics {
    return new KbAskMetrics(opts.orgId);
  }

  finish(outcome: KbAskOutcome, facts: KbAskFacts = {}): void {
    if (this.finished) return;
    this.finished = true;

    this.attributes["kb.ask.outcome"] = outcome;
    this.attributes["kb.ask.duration_ms"] = Date.now() - this.startedAt;
    this.attributes["kb.ask.citations"] = facts.citations ?? 0;
    this.attributes["kb.ask.candidates"] = facts.candidates ?? 0;
    this.attributes["kb.ask.degraded"] = facts.degraded ?? false;

    this.span.end(NON_FAULT_ASK_OUTCOMES.has(outcome) ? "ok" : "error");
  }
}
