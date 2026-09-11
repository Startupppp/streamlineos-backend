import type { HealthComposite } from "./health-score";

/** The three probes and four aggregates a single assessment needs. */
export interface SourceAvailability {
  readonly engagement: boolean;
  readonly support: boolean;
  readonly sentiment: boolean;
  readonly usage: boolean;
}

/** What a computed assessment looks like on the wire. */
export interface HealthAssessmentView {
  readonly partyId: string;
  readonly partyName: string | null;
  readonly customerHealthAssessmentId: string;
  readonly computedAt: Date;
  readonly score: number | null;
  readonly band: string | null;
  readonly coverageBps: number;
  readonly weightsVersion: number;
  readonly weightsBps: Readonly<Record<string, number>>;
  readonly factors: HealthComposite["factors"];
  readonly unscored: HealthComposite["unscored"];
}
