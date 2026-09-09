import { CallExemplarsService } from "./call-exemplars.service";
import {
  ORG,
  HOUR,
  analysis,
  buildCohort,
  consentRefusing,
  contextFor,
  humanCall,
  type FixtureMember,
} from "./call-intelligence.spec-fixtures";

/**
 * CRM-P2-06's two rules, each proved by the call that must NOT come back.
 *
 * **Consent.** The refused call in every fixture below is deliberately the one
 * that would win. A test where the excluded row would have placed fourth proves
 * only that the sort is stable; a test where it holds a perfect talk ratio and
 * still does not appear proves the gate is load-bearing. The failure being
 * prevented is not abstract: an exemplar is a link somebody sends to five
 * colleagues, so surfacing a recording made without the agreement a jurisdiction
 * required is the version of the mistake that ends up in a QBR deck.
 *
 * **Visibility.** A colleague's call in its private window is not an exemplar
 * either, and here the stakes are higher than in an aggregate: a leaked number
 * is a number, and a leaked exemplar is an invitation to click through to
 * somebody's first read of their own call before they have had it.
 */

const REP_A = "user-rep-a";
const REP_B = "user-rep-b";
const MANAGER = "user-manager";

const MEMBERS: FixtureMember[] = [
  { userId: REP_A, organizationId: ORG, name: "Ana Reyes" },
  { userId: REP_B, organizationId: ORG, name: "Bo Nakamura" },
];

const query = { metric: "talk-ratio" as const, sinceDays: 30, page: 1, limit: 10 };

describe("best-call exemplar search over the cohort", () => {
  it("never surfaces a call the consent rule refuses, even when it would rank first", async () => {
    const analyses = [
      /** Dead on the target. Under any ranking this is the best call there is. */
      analysis({ activityId: "no-consent", talkRatioBps: 5000 }),
      analysis({ activityId: "consented", talkRatioBps: 6400 }),
    ];
    const calls = [humanCall("no-consent", REP_A), humanCall("consented", REP_A)];

    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
      consent: consentRefusing(["no-consent"]),
    });
    const service = new CallExemplarsService(db, cohort);

    const result = await service.search(contextFor(REP_A), query);

    expect(result.rows.map((row) => row.activityId)).toEqual(["consented"]);
    expect(result.total).toBe(1);
    /**
     * Counted as `consentBlocked` and not as `ineligible`. "We could not measure
     * this" and "this may never be processed" lead a reader to two different
     * actions, and only one of them is something they can fix.
     */
    expect(result.consentBlocked).toBe(1);
    expect(result.ineligible).toBe(0);
    expect(result.embargoed).toBe(0);
  });

  it("keeps a refused call out of every metric, not just the one it would win", async () => {
    const analyses = [
      analysis({
        activityId: "no-consent",
        talkRatioBps: 5000,
        repTurnCount: 20,
        repQuestionCount: 20,
        nextStepCommitted: true,
      }),
      analysis({
        activityId: "consented",
        talkRatioBps: 7000,
        repTurnCount: 10,
        repQuestionCount: 1,
        nextStepCommitted: true,
      }),
    ];
    const calls = [humanCall("no-consent", REP_A), humanCall("consented", REP_A)];

    for (const metric of ["talk-ratio", "question-rate", "next-step"] as const) {
      const { db, cohort } = buildCohort(analyses, calls, {
        canReadTeam: true,
        members: MEMBERS,
        consent: consentRefusing(["no-consent"]),
      });
      const service = new CallExemplarsService(db, cohort);

      const result = await service.search(contextFor(REP_A), { ...query, metric });

      // The refused call holds the best talk ratio, the best question rate and a
      // committed next step. It appears under none of the three.
      expect(result.rows.map((row) => row.activityId)).toEqual(["consented"]);
    }
  });

  it("does not offer a manager a call the rep has not read yet", async () => {
    const analyses = [
      analysis({
        activityId: "fresh",
        createdAt: new Date(Date.now() - HOUR),
        talkRatioBps: 5000,
      }),
      analysis({ activityId: "settled", talkRatioBps: 6800 }),
    ];
    const calls = [humanCall("fresh", REP_B), humanCall("settled", REP_B)];

    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallExemplarsService(db, cohort);

    const result = await service.search(contextFor(MANAGER), query);

    expect(result.rows.map((row) => row.activityId)).toEqual(["settled"]);
    expect(result.embargoed).toBe(1);
  });

  it("offers the rep their own fresh call, because it was always theirs", async () => {
    const analyses = [
      analysis({
        activityId: "fresh",
        createdAt: new Date(Date.now() - HOUR),
        talkRatioBps: 5000,
      }),
      analysis({ activityId: "settled", talkRatioBps: 6800 }),
    ];
    const calls = [humanCall("fresh", REP_B), humanCall("settled", REP_B)];

    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: false,
      members: MEMBERS,
    });
    const service = new CallExemplarsService(db, cohort);

    const result = await service.search(contextFor(REP_B), query);

    expect(result.rows.map((row) => row.activityId)).toEqual(["fresh", "settled"]);
    expect(result.scope).toBe("own");
  });

  it("gives a rep without view-team none of a colleague's calls, and no count of them", async () => {
    const analyses = [
      analysis({ activityId: "mine", talkRatioBps: 7500 }),
      /** Better on the metric, and not this reader's to be offered. */
      analysis({ activityId: "theirs", talkRatioBps: 5000 }),
    ];
    const calls = [humanCall("mine", REP_A), humanCall("theirs", REP_B)];

    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: false,
      members: MEMBERS,
    });
    const service = new CallExemplarsService(db, cohort);

    const result = await service.search(contextFor(REP_A), query);

    expect(result.rows.map((row) => row.activityId)).toEqual(["mine"]);
    // Not reported as embargoed: it was never in scope, and a count would say
    // how many calls the rest of the team made.
    expect(result.embargoed).toBe(0);
    expect(result.ineligible).toBe(0);
  });

  it("names the rep on an exemplar so a client never has to render an id", async () => {
    const analyses = [analysis({ activityId: "one", talkRatioBps: 5000 })];
    const calls = [humanCall("one", REP_A)];

    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallExemplarsService(db, cohort);

    const result = await service.search(contextFor(MANAGER), query);

    expect(result.rows[0]!.repName).toBe("Ana Reyes");
    expect(result.rows[0]!.occurredAt).toBeInstanceOf(Date);
  });

  it("separates 'could not be measured' from 'not yours' and 'never allowed'", async () => {
    const analyses = [
      analysis({ activityId: "good", talkRatioBps: 5100 }),
      /** Visible and consented, and there is no talk ratio to rank it on. */
      analysis({
        activityId: "undiarised",
        talkRatioBps: null,
        repTurnCount: null,
        repQuestionCount: null,
      }),
      analysis({ activityId: "refused", talkRatioBps: 5000 }),
      analysis({
        activityId: "embargoed",
        createdAt: new Date(Date.now() - HOUR),
        talkRatioBps: 5000,
      }),
    ];
    const calls = [
      humanCall("good", REP_A),
      humanCall("undiarised", REP_A),
      humanCall("refused", REP_A),
      humanCall("embargoed", REP_B),
    ];

    const { db, cohort } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
      consent: consentRefusing(["refused"]),
    });
    const service = new CallExemplarsService(db, cohort);

    const result = await service.search(contextFor(MANAGER), query);

    expect(result.rows.map((row) => row.activityId)).toEqual(["good"]);
    expect(result.ineligible).toBe(1);
    expect(result.consentBlocked).toBe(1);
    expect(result.embargoed).toBe(1);
  });

  it("scopes every read it makes to the caller's organisation", async () => {
    const analyses = [analysis({ activityId: "one", talkRatioBps: 5000 })];
    const calls = [humanCall("one", REP_A)];

    const { db, cohort, orgsAsked } = buildCohort(analyses, calls, {
      canReadTeam: true,
      members: MEMBERS,
    });
    const service = new CallExemplarsService(db, cohort);

    await service.search(contextFor(MANAGER), query);

    expect(orgsAsked.length).toBeGreaterThanOrEqual(4);
    for (const org of orgsAsked) expect(org).toBe(ORG);
  });
});
