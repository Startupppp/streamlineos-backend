import { startSpan, type OpenSpan } from "../../../common/observability";

export const KB_READ_SPAN_NAME = "kb.read.operation";

export const KB_READ_OUTCOMES = [
  "found",
  "not_found",
  "denied",
  "error",
] as const;

export type KbReadOutcome = (typeof KB_READ_OUTCOMES)[number];

export const KB_READ_QUEUE_LANE = "sync" as const;

const NON_FAULT_READ_OUTCOMES: ReadonlySet<KbReadOutcome> = new Set<KbReadOutcome>([
  "found",
  "not_found",
]);

export function isKbReadFault(outcome: KbReadOutcome): boolean {
  return !NON_FAULT_READ_OUTCOMES.has(outcome);
}

export interface KbReadFacts {
  contentType?: string;
  cacheOutcome?: string;
  dbRole?: string;
  queueLane?: string;
  sourceKind?: string;
}

export class KbReadMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private finished = false;

  private constructor(opts: { orgId: string; actorStanding?: string; orgCell?: string }) {
    if (opts.orgId) this.attributes["org.id"] = opts.orgId;
    if (opts.actorStanding) this.attributes["actor.standing"] = opts.actorStanding;
    if (opts.orgCell) this.attributes["org.cell"] = opts.orgCell;
    this.span = startSpan(KB_READ_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: { orgId: string; actorStanding?: string; orgCell?: string }): KbReadMetrics {
    return new KbReadMetrics(opts);
  }

  finish(outcome: KbReadOutcome, facts: KbReadFacts = {}): void {
    if (this.finished) return;
    this.finished = true;

    this.attributes["kb.read.outcome"] = outcome;
    this.attributes["kb.read.duration_ms"] = Date.now() - this.startedAt;
    this.attributes["kb.read.content_type"] = facts.contentType ?? "page";
    this.attributes["kb.read.cache_outcome"] = facts.cacheOutcome ?? "miss";
    this.attributes["kb.read.db_role"] = facts.dbRole ?? "primary";
    this.attributes["kb.read.queue_lane"] = facts.queueLane ?? KB_READ_QUEUE_LANE;
    this.attributes["kb.read.source_kind"] = facts.sourceKind ?? "none";

    this.span.end(NON_FAULT_READ_OUTCOMES.has(outcome) ? "ok" : "error");
  }
}
