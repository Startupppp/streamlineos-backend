export interface PmSummaryCase {
  name: string;
  projectEvidence: string;
  expectedHighlightsMin: number;
  mustNotClaimBeyondEvidence: boolean;
}

export const PM_SUMMARIES_DATASET: readonly PmSummaryCase[] = [
  {
    name: "on-track-project",
    projectEvidence:
      "Project: Alpha Launch. Completed tickets: 42 of 60. Open blockers: 0. " +
      "Sprint velocity: 14 points/week. Next milestone: Beta release in 3 weeks. " +
      "Recent completions: User auth module, Dashboard v2, Email notifications.",
    expectedHighlightsMin: 1,
    mustNotClaimBeyondEvidence: true,
  },
  {
    name: "at-risk-project",
    projectEvidence:
      "Project: Backend Rewrite. Completed tickets: 10 of 50. Open blockers: 3. " +
      "Sprint velocity: 6 points/week (down from 12). " +
      "Blockers: DB migration stuck, external API unstable, team member on leave.",
    expectedHighlightsMin: 1,
    mustNotClaimBeyondEvidence: true,
  },
  {
    name: "completed-sprint",
    projectEvidence:
      "Sprint 12 complete. Delivered: payment gateway integration, CSV export, bulk import. " +
      "0 carry-over tickets. Team satisfaction: 4.2/5.",
    expectedHighlightsMin: 1,
    mustNotClaimBeyondEvidence: true,
  },
  {
    name: "minimal-evidence",
    projectEvidence: "Project: TBD. No tickets created yet. Team size: 3.",
    expectedHighlightsMin: 0,
    mustNotClaimBeyondEvidence: true,
  },
  {
    name: "high-velocity-multi-milestone",
    projectEvidence:
      "Project: ERP Integration. Phase 1 complete (invoicing). Phase 2 in progress (inventory). " +
      "Completed 28 of 35 Phase 2 tickets. Current velocity: 18 pts/week. " +
      "Phase 3 (reporting) scoped but not started. No blockers.",
    expectedHighlightsMin: 2,
    mustNotClaimBeyondEvidence: true,
  },
  {
    name: "overdue-milestone",
    projectEvidence:
      "Project: Mobile App. Deadline was 2026-06-30 (2 weeks overdue). " +
      "Remaining tickets: 8 (all in QA). Latest blocker resolved yesterday. " +
      "Estimated completion: 2026-07-20.",
    expectedHighlightsMin: 1,
    mustNotClaimBeyondEvidence: true,
  },
  {
    name: "no-evidence-unsupported",
    projectEvidence: "",
    expectedHighlightsMin: 0,
    mustNotClaimBeyondEvidence: true,
  },
] as const;
