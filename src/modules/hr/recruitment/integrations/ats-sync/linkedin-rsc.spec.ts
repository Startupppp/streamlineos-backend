import {
  resolveRsc,
  rscStateToStage,
  RSC_ADAPTERS,
  RSC_STATES,
  STAGE_TO_RSC,
  type CandidateStage,
} from "./linkedin-rsc";
import { STAGE_TRANSITIONS } from "../../recruitment-candidate-stages";

const LIVE = { platform: "LINKEDIN_RSC", isActive: true, token: "partner-key", meta: {} };

describe("LinkedIn RSC is blocked, and says so in the same vocabulary as everything else", () => {
  it("has no registered adapter", () => {
    expect(RSC_ADAPTERS.size).toBe(0);
  });

  /**
   * The case that matters most. Credentials present, integration switched on —
   * and still blocked, because a partner key without a partnership is not a
   * capability. A stub that "succeeded" here is exactly the class of defect
   * this whole pass exists to remove.
   */
  it("refuses a live call even with credentials saved and the row active", () => {
    const resolved = resolveRsc(LIVE);
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
  });

  it("tells an unconnected organisation it is not connected", () => {
    expect(resolveRsc(null)).toMatchObject({ status: "BLOCKED", code: "no-integration" });
  });

  it("names the manual fallback rather than leaving a dead end", () => {
    const resolved = resolveRsc(LIVE);
    expect("message" in resolved && resolved.message).toMatch(/Recruitment OS|separate list/i);
  });
});

describe("the stage mapping, which is ours to get right before a partnership, not during one", () => {
  it("maps every pipeline stage to a state LinkedIn publishes", () => {
    for (const [stage, state] of Object.entries(STAGE_TO_RSC))
      expect([stage, RSC_STATES.includes(state)]).toEqual([stage, true]);
  });

  /**
   * The table is a `Record<CandidateStage, RscState>`, so this is really a
   * compile-time property — asserted at runtime as well because the thing it
   * guards against is a seventh stage being added to the pipeline and syncing
   * as `NEW` without anyone noticing.
   */
  it("covers every stage the pipeline can be in", () => {
    const pipelineStages = Object.keys(STAGE_TRANSITIONS) as CandidateStage[];
    for (const stage of pipelineStages)
      expect([stage, stage in STAGE_TO_RSC]).toEqual([stage, true]);
  });

  it("round-trips every stage through LinkedIn's vocabulary and back", () => {
    for (const stage of Object.keys(STAGE_TO_RSC) as CandidateStage[])
      expect(rscStateToStage(STAGE_TO_RSC[stage])).toBe(stage);
  });

  it("reads a state case-insensitively, because vendors are inconsistent", () => {
    expect(rscStateToStage("interviewing")).toBe("INTERVIEW");
  });

  /**
   * LinkedIn has states we do not model. One we cannot place has to land where
   * a recruiter will look — an applicant at the top of the pipeline is
   * recoverable, and one silently dropped is not.
   */
  it("places a state it does not know at the top of the pipeline rather than dropping it", () => {
    expect(rscStateToStage("ARCHIVED_BY_LINKEDIN")).toBe("NEW");
    expect(rscStateToStage("")).toBe("NEW");
  });
});
