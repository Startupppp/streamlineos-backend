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
  queueLane?: string;
  sourceKind?: string;
  cacheOutcome?: string;
  dbRole?: string;
}

export class KbAskMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private finished = false;

  private constructor(opts: { orgId: string; actorStanding?: string; orgCell?: string }) {
    if (opts.orgId) this.attributes["org.id"] = opts.orgId;
    if (opts.actorStanding) this.attributes["actor.standing"] = opts.actorStanding;
    if (opts.orgCell) this.attributes["org.cell"] = opts.orgCell;
    this.span = startSpan(KB_ASK_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: { orgId: string; actorStanding?: string; orgCell?: string }): KbAskMetrics {
    return new KbAskMetrics(opts);
  }

  finish(outcome: KbAskOutcome, facts: KbAskFacts = {}): void {
    if (this.finished) return;
    this.finished = true;

    this.attributes["kb.ask.outcome"] = outcome;
    this.attributes["kb.ask.duration_ms"] = Date.now() - this.startedAt;
    this.attributes["kb.ask.citations"] = facts.citations ?? 0;
    this.attributes["kb.ask.candidates"] = facts.candidates ?? 0;
    this.attributes["kb.ask.degraded"] = facts.degraded ?? false;
    this.attributes["kb.ask.queue_lane"] = facts.queueLane ?? "fast";
    this.attributes["kb.ask.source_kind"] = facts.sourceKind ?? "none";
    this.attributes["kb.ask.cache_outcome"] = facts.cacheOutcome ?? "miss";
    this.attributes["kb.ask.db_role"] = facts.dbRole ?? "primary";

    this.span.end(NON_FAULT_ASK_OUTCOMES.has(outcome) ? "ok" : "error");
  }
}
