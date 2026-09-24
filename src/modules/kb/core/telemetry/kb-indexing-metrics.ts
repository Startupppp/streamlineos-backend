import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { startSpan, type OpenSpan } from "../../../../common/observability";

export const KB_INDEXING_SPAN_NAME = "kb.indexing.operation";

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
}

export class KbIndexingMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private embeddedChunks = 0;
  private finished = false;

  private constructor(contentType: KbIndexingContentType, orgId: string | undefined) {
    this.attributes["kb.content_type"] = contentType;
    if (orgId) this.attributes["org.id"] = orgId;
    this.span = startSpan(KB_INDEXING_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: {
    contentType: KbIndexingContentType;
    orgId?: string;
  }): KbIndexingMetrics {
    return new KbIndexingMetrics(opts.contentType, opts.orgId);
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

    this.span.end(NON_FAULT_OUTCOMES.has(outcome) ? "ok" : "error");
  }
}
