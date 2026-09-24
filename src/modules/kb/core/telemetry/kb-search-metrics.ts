import { startSpan, type OpenSpan } from "../../../../common/observability";

export const KB_SEARCH_SPAN_NAME = "kb.search.operation";

export const KB_SEARCH_OUTCOMES = [
  "found",
  "not_found",
  "denied",
  "error",
] as const;

export type KbSearchOutcome = (typeof KB_SEARCH_OUTCOMES)[number];

export class KbSearchMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private finished = false;

  private constructor(orgId: string) {
    if (orgId) this.attributes["org.id"] = orgId;
    this.span = startSpan(KB_SEARCH_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: { orgId: string }): KbSearchMetrics {
    return new KbSearchMetrics(opts.orgId);
  }

  finish(outcome: KbSearchOutcome, facts: { results?: number } = {}): void {
    if (this.finished) return;
    this.finished = true;

    this.attributes["kb.search.outcome"] = outcome;
    this.attributes["kb.search.duration_ms"] = Date.now() - this.startedAt;
    this.attributes["kb.search.results"] = facts.results ?? 0;

    this.span.end(outcome === "error" ? "error" : "ok");
  }
}
