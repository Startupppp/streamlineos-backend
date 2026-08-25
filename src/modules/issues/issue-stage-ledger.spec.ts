import { ISSUE_STAGES } from "../../db/schema/crm/issue-records";
import {
  ALLOWED_STAGE_TRANSITIONS,
  actorColumns,
  canTransition,
  clockStamps,
  isTerminal,
} from "./issue-stage-ledger";

/**
 * The accountability rules, argued against a test rather than a database.
 *
 * The actor cases are the ones that matter. `deal_stage_transitions` exists
 * because a stage change the system made had nowhere to say it was a system —
 * and the way that bug comes back is not a missing column, it is a caller
 * filling in a user id "so the row is complete".
 */
describe("who moved it", () => {
  it("files a person under their own id and no label", () => {
    expect(actorColumns({ kind: "human", userId: "user_9" })).toEqual({
      actorKind: "human",
      actorUserId: "user_9",
      actorLabel: null,
    });
  });

  /**
   * The whole point. An SLA sweep escalating a complaint at 3am is accountable
   * and had no person behind it, so it names itself and borrows nobody.
   */
  it("lets the system name itself without wearing a person's name", () => {
    expect(actorColumns({ kind: "system", label: "sla-sweep" })).toEqual({
      actorKind: "system",
      actorUserId: null,
      actorLabel: "sla-sweep",
    });
  });

  it("cannot produce a row the CHECK would refuse", () => {
    for (const actor of [
      { kind: "human", userId: "user_1" },
      { kind: "system", label: "escalation-policy" },
    ] as const) {
      const columns = actorColumns(actor);
      const human = columns.actorKind === "human" && columns.actorUserId !== null;
      const system =
        columns.actorKind === "system" &&
        columns.actorUserId === null &&
        columns.actorLabel !== null;
      expect(human || system).toBe(true);
    }
  });
});

describe("which moves are legal", () => {
  it("never allows a record to transition to itself", () => {
    for (const stage of ISSUE_STAGES) expect(canTransition(stage, stage)).toBe(false);
  });

  it("declares a rule for every stage", () => {
    expect(Object.keys(ALLOWED_STAGE_TRANSITIONS).sort()).toEqual([...ISSUE_STAGES].sort());
  });

  it("lets anything open be escalated, acknowledged, resolved or dismissed", () => {
    expect(canTransition("open", "escalated")).toBe(true);
    expect(canTransition("open", "acknowledged")).toBe(true);
    expect(canTransition("acknowledged", "escalated")).toBe(true);
  });

  /**
   * The single most important transition this table records. A customer saying
   * "this is not fixed" must attach to the original failure, not open a second
   * complaint that has lost the connection to the remedy that failed.
   */
  it("lets a closed record be reopened from either terminal stage", () => {
    expect(canTransition("resolved", "open")).toBe(true);
    expect(canTransition("dismissed", "open")).toBe(true);
  });

  it("does not let a closed record jump straight to another closed stage", () => {
    expect(canTransition("resolved", "dismissed")).toBe(false);
    expect(canTransition("dismissed", "resolved")).toBe(false);
  });

  it("lets an escalation be handed back", () => {
    expect(canTransition("escalated", "acknowledged")).toBe(true);
  });

  it("names exactly two terminal stages", () => {
    expect(ISSUE_STAGES.filter(isTerminal)).toEqual(["resolved", "dismissed"]);
  });
});

describe("the clock a move stamps", () => {
  const at = new Date("2026-02-01T09:00:00.000Z");

  it("closes on a terminal stage", () => {
    expect(clockStamps("resolved", at, null)).toEqual({ closedAt: at });
    expect(clockStamps("dismissed", at, null)).toEqual({ closedAt: at });
  });

  /**
   * Reopening clears the closing time, which is what keeps
   * `chk_issue_records_closed` true through a reopen rather than leaving each
   * caller to remember.
   */
  it("clears the closing time on every non-terminal stage", () => {
    expect(clockStamps("open", at, null).closedAt).toBeNull();
    expect(clockStamps("escalated", at, null).closedAt).toBeNull();
  });

  it("stamps the first acknowledgement and never a later one", () => {
    expect(clockStamps("acknowledged", at, null).acknowledgedAt).toEqual(at);
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    expect(clockStamps("acknowledged", at, earlier).acknowledgedAt).toBeUndefined();
  });

  /**
   * Escalating straight from `open` deliberately leaves `acknowledgedAt` null.
   * "Escalated without anyone ever acknowledging it" is the most useful thing
   * this record can say about how a failure was handled, and stamping it here
   * would erase exactly that.
   */
  it("does not treat an escalation as an acknowledgement", () => {
    expect(clockStamps("escalated", at, null).acknowledgedAt).toBeUndefined();
  });
});
