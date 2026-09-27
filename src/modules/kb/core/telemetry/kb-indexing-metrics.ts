import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { startSpan, type OpenSpan } from "../../../../common/observability";

export const KB_INDEXING_SPAN_NAME = "kb.indexing.operation";

export const KB_INDEXING_QUEUE_LANE = "background" as const;

export const KB_INDEXING_OUTCOMES = [
  "indexed",
  "reused",
  "acl_only",
  "skipped_no_content",
  "embedding_unavailable",
  "credits_exhausted",
  "cancelled",
  "error",
] as const;

export type KbIndexingOutcome = (typeof KB_INDEXING_OUTCOMES)[number];

export type KbIndexingContentType = "page" | "article" | "attachment";

const NON_FAULT_OUTCOMES: ReadonlySet<KbIndexingOutcome> = new Set<KbIndexingOutcome>([
  "indexed",
  "reused",
  "acl_only",
  "skipped_no_content",
  "cancelled",
]);

export function isKbIndexingFault(outcome: KbIndexingOutcome): boolean {
  return !NON_FAULT_OUTCOMES.has(outcome);
}

export function kbIndexingOutcomeForError(error: unknown): KbIndexingOutcome {
  if (error instanceof InsufficientAiCreditsException) return "credits_exhausted";
  if (error instanceof ServiceUnavailableException) return "embedding_unavailable";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
}

export interface KbIndexingFacts {
  chunks?: number;
  embedded?: number;
  reused?: boolean;
  queueLane?: string;
  dbRole?: string;
}

export class KbIndexingMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private embeddedChunks = 0;
  private finished = false;

  private constructor(opts: { contentType: KbIndexingContentType; orgId?: string; orgCell?: string }) {
    this.attributes["kb.content_type"] = opts.contentType;
    if (opts.orgId) this.attributes["org.id"] = opts.orgId;
    if (opts.orgCell) this.attributes["org.cell"] = opts.orgCell;
    this.span = startSpan(KB_INDEXING_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: {
    contentType: KbIndexingContentType;
    orgId?: string;
    orgCell?: string;
  }): KbIndexingMetrics {
    return new KbIndexingMetrics(opts);
  }

  embedded(count: number): void {
    this.embeddedChunks += count > 0 ? count : 0;
  }

  finish(outcome: KbIndexingOutcome, facts: KbIndexingFacts = {}): void {
    if (this.finished) return;
    this.finished = true;

    this.attributes["kb.outcome"] = outcome;
    this.attributes["kb.duration_ms"] = Date.now() - this.startedAt;
    this.attributes["kb.chunks"] = facts.chunks ?? 0;
    this.attributes["kb.embedded"] = facts.embedded ?? this.embeddedChunks;
    this.attributes["kb.reused"] = facts.reused ?? false;
    this.attributes["kb.indexing.queue_lane"] = facts.queueLane ?? KB_INDEXING_QUEUE_LANE;
    this.attributes["kb.indexing.db_role"] = facts.dbRole ?? "primary";

    this.span.end(NON_FAULT_OUTCOMES.has(outcome) ? "ok" : "error");
  }
}
