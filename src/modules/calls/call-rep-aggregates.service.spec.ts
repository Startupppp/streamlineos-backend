import { CallRepAggregatesService } from "./call-rep-aggregates.service";
import {
  ORG,
  HOUR,
  analysis,
  buildCohort,
  contextFor,
  humanCall,
  type FixtureActivity,
  type FixtureAnalysis,
  type FixtureMember,
} from "./call-intelligence.spec-fixtures";

/**
 * CRM-P2-05's one dangerous failure: an aggregate that leaks another rep's calls
 * through a group-by.
 *
 * `call-rep-aggregates.spec.ts` proves the arithmetic; this proves the service
 * never hands that arithmetic a row it should not have. The distinction is the
 * whole test. An implementation that selected the window, grouped by
 * `actor_user_id` and returned the rows would be correct-looking, fast, and
 * would put every rep's talk ratio in front of every rep — and nothing would
 * raise, because a leaked aggregate is indistinguishable from a correct one
 * unless a test knows who was supposed to be in it.
 *
 * So every assertion below is about a rep who must NOT appear, run with two reps
 * in the fixture and the same data seen twice through two different readers.
 */

const REP_A = "user-rep-a";
const REP_B = "user-rep-b";
const MANAGER = "user-manager";

const MEMBERS: FixtureMember[] = [
  { userId: REP_A, organizationId: ORG, name: "Ana Reyes" },
  { userId: REP_B, organizationId: ORG, name: "Bo Nakamura" },
];

/** Two settled calls each, plus one of Bo's analysed an hour ago. */
function team() {
  return {
    analyses: [
      analysis({ activityId: "a-1", talkRatioBps: 4000 }),
      analysis({ activityId: "a-2", talkRatioBps: 4200 }),
      analysis({ activityId: "b-1", talkRatioBps: 9000 }),
      analysis({ activityId: "b-2", talkRatioBps: 9200 }),
      analysis({
        activityId: "b-fresh",
        createdAt: new Date(Date.now() - HOUR),
        talkRatioBps: 100,
      }),
    ],
    calls: [
      humanCall("a-1", REP_A),
      humanCall("a-2", REP_A),
      humanCall("b-1", REP_B),
      humanCall("b-2", REP_B),
      humanCall("b-fresh", REP_B),
    ],
  };
}

const query = { sinceDays: 30, page: 1, limit: 25 };

describe("per-rep call aggregates over the cohort", () => {
  it("gives a rep without view-team exactly one row: their own", async () => {
    const { analyses, calls } = team();
    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: false,
      members: MEMBERS,
    });
    const service = new CallRepAggregatesService(db, cohort);

    const result = await service.aggregate(contextFor(REP_A), query);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.repUserId).toBe(REP_A);
    expect(result.rows[0]!.repName).toBe("Ana Reyes");
    expect(result.scope).toBe("own");
    /**
     * The median that would appear if Bo's calls had leaked is 9000-ish. 4100 is
     * Ana's own pair and nothing else, which is the assertion that a group-by
     * over the raw window would fail.
     */
    expect(result.rows[0]!.medianTalkRatioBps).toBe(4100);
  });

  it("tells that rep nothing about how many calls the rest of the team made", async () => {
    const { analyses, calls } = team();
    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: false,
      members: MEMBERS,
    });
    const service = new CallRepAggregatesService(db, cohort);

    const result = await service.aggregate(contextFor(REP_A), query);

    /**
     * Three of Bo's calls are in the window and none of them is Ana's business.
     * A total of 3 here would be a report of a colleague's week delivered as
     * bookkeeping — which is why `not-your-call` is dropped and only
     * `rep-window` is counted.
     */
    expect(result.embargoed).toBe(0);
    expect(result.total).toBe(1);
    expect(result.unattributed).toBe(0);
  });

  it("gives a manager both reps, and still withholds the call that has not opened", async () => {
    const { analyses, calls } = team();
    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallRepAggregatesService(db, cohort);

    const result = await service.aggregate(contextFor(MANAGER), query);

    expect(result.scope).toBe("team");
    expect(result.rows.map((row) => row.repUserId).sort()).toEqual([REP_A, REP_B]);

    const bo = result.rows.find((row) => row.repUserId === REP_B)!;
    expect(bo.callsAnalysed).toBe(2);
    expect(bo.embargoed).toBe(1);
    /**
     * 9100 is the median of Bo's two settled calls. If the hour-old one had been
     * counted the median would be 9000 — a number that is wrong by a hundred
     * basis points and that no reviewer would ever question. That is exactly why
     * the fresh call's talk ratio is 100 in the fixture: it moves the answer far
     * enough that the test cannot pass by coincidence.
     */
    expect(bo.medianTalkRatioBps).toBe(9100);
    expect(result.embargoed).toBe(1);
  });

  it("lets the rep read their own fresh call while their manager cannot", async () => {
    const { analyses, calls } = team();

    const boSees = await readerOver(analyses, calls, false).aggregate(contextFor(REP_B), query);
    const managerSees = await readerOver(analyses, calls, true).aggregate(
      contextFor(MANAGER),
      query,
    );

    // The rule's first clause: the rep who was on the call always reads it, with
    // no window and no permission subtlety.
    expect(boSees.rows[0]!.callsAnalysed).toBe(3);
    expect(boSees.rows[0]!.embargoed).toBe(0);
    expect(managerSees.rows.find((row) => row.repUserId === REP_B)!.callsAnalysed).toBe(2);
  });

  it("scopes every read it makes to the caller's organisation", async () => {
    const { analyses, calls } = team();
    const { db, cohort, orgsAsked } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallRepAggregatesService(db, cohort);

    await service.aggregate(contextFor(MANAGER), query);

    // Analyses, activities, releases and the member join. What leaks out of this
    // table is what a named customer said, so the predicate is asserted rather
    // than assumed.
    expect(orgsAsked.length).toBeGreaterThanOrEqual(4);
    for (const org of orgsAsked) expect(org).toBe(ORG);
  });

  it("leaves a rep who has left the organisation without a fabricated name", async () => {
    const { analyses, calls } = team();
    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      // Bo is gone: no membership row, so the join resolves nothing for them.
      members: [MEMBERS[0]!],
    });
    const service = new CallRepAggregatesService(db, cohort);

    const result = await service.aggregate(contextFor(MANAGER), query);

    expect(result.rows.find((row) => row.repUserId === REP_B)!.repName).toBeNull();
  });

  it("paginates over reps and reports the real total", async () => {
    const { analyses, calls } = team();
    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallRepAggregatesService(db, cohort);

    const first = await service.aggregate(contextFor(MANAGER), {
      sinceDays: 30,
      page: 1,
      limit: 1,
    });
    const second = await service.aggregate(contextFor(MANAGER), {
      sinceDays: 30,
      page: 2,
      limit: 1,
    });

    expect(first.total).toBe(2);
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    // Deterministic ordering: no rep appears on two pages and none on neither.
    expect(first.rows[0]!.repUserId).not.toBe(second.rows[0]!.repUserId);
  });

  it("labels the trend bucket it chose rather than letting a caller pick one", async () => {
    const { analyses, calls } = team();
    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallRepAggregatesService(db, cohort);

    const month = await service.aggregate(contextFor(MANAGER), query);
    const week = await service.aggregate(contextFor(MANAGER), {
      sinceDays: 7,
      page: 1,
      limit: 25,
    });

    expect(month.bucket).toBe("week");
    expect(week.bucket).toBe("day");
    expect(week.rows[0]!.trend).toHaveLength(7);
  });
});

/** One reader's view of the same fixture, so the comparison above reads as one line each. */
function readerOver(
  analyses: FixtureAnalysis[],
  calls: FixtureActivity[],
  canReadTeam: boolean,
): CallRepAggregatesService {
  const built = buildCohort(analyses, calls, { canReadTeam, members: MEMBERS });
  return new CallRepAggregatesService(built.db, built.cohort);
}
