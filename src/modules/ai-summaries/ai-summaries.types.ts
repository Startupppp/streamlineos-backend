import type { AiSummarySnapshot } from "../../db/schema/ai/ai-summaries";

export interface SnapshotStructured {
  highlights: string[];
  blockers: string[];
  nextActions: string[];
}

export interface SnapshotCitation {
  id: string | number;
  title: string;
  href?: string;
  snippet?: string;
  freshness?: string;
}

export interface SnapshotPayload {
  summary: string;
  structured: SnapshotStructured;
  citations?: SnapshotCitation[];
  correlationId?: string;
  confidence?: number;
}

export interface FieldDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface SnapshotDiff {
  highlights: FieldDiff;
  blockers: FieldDiff;
  nextActions: FieldDiff;
  isSameSnapshot: boolean;
}

export interface SnapshotWithDiff {
  snapshot: AiSummarySnapshot;
  diff: SnapshotDiff | null;
}
