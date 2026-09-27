import { startSpan, type OpenSpan } from "../../../common/observability";

export const KB_WRITE_SPAN_NAME = "kb.write.operation";

export const KB_WRITE_OUTCOMES = [
  "created",
  "updated",
  "deleted",
  "conflict",
  "denied",
  "error",
] as const;

export type KbWriteOutcome = (typeof KB_WRITE_OUTCOMES)[number];

export const KB_WRITE_QUEUE_LANE = "sync" as const;

const NON_FAULT_WRITE_OUTCOMES: ReadonlySet<KbWriteOutcome> = new Set<KbWriteOutcome>([
  "created",
  "updated",
  "deleted",
  "conflict",
]);

export function isKbWriteFault(outcome: KbWriteOutcome): boolean {
  return !NON_FAULT_WRITE_OUTCOMES.has(outcome);
}

export function kbWriteOutcomeForError(error: unknown): KbWriteOutcome {
  if (error instanceof Error && error.message.includes("conflict")) return "conflict";
  return "error";
}

export interface KbWriteFacts {
  contentType?: string;
  dbRole?: string;
  queueLane?: string;
}

export class KbWriteMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private finished = false;

  private constructor(opts: { orgId: string; actorStanding?: string; orgCell?: string }) {
    if (opts.orgId) this.attributes["org.id"] = opts.orgId;
    if (opts.actorStanding) this.attributes["actor.standing"] = opts.actorStanding;
    if (opts.orgCell) this.attributes["org.cell"] = opts.orgCell;
    this.span = startSpan(KB_WRITE_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: { orgId: string; actorStanding?: string; orgCell?: string }): KbWriteMetrics {
    return new KbWriteMetrics(opts);
  }

  finish(outcome: KbWriteOutcome, facts: KbWriteFacts = {}): void {
    if (this.finished) return;
    this.finished = true;

    this.attributes["kb.write.outcome"] = outcome;
    this.attributes["kb.write.duration_ms"] = Date.now() - this.startedAt;
    this.attributes["kb.write.content_type"] = facts.contentType ?? "page";
    this.attributes["kb.write.db_role"] = facts.dbRole ?? "primary";
    this.attributes["kb.write.queue_lane"] = facts.queueLane ?? KB_WRITE_QUEUE_LANE;

    this.span.end(NON_FAULT_WRITE_OUTCOMES.has(outcome) ? "ok" : "error");
  }
}
