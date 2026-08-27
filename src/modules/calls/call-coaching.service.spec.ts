import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { ActivityActorKind } from "../../db/schema/crm/activities";
import type { Db } from "../../db/drizzle.types";
import { activities } from "../../db/schema";
import {
  callAnalyses,
  callAnalysisReleases,
} from "../../db/schema/crm/call-analysis";
import type { AccessService } from "../access/access.service";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import { COACHING_MIN_COHORT } from "./call-coaching";
import { CallCoachingService } from "./call-coaching.service";

/**
 * `call-coaching.spec.ts` proves the digest function excludes what it is handed
 * as embargoed. This proves the service actually hands it that — which is a
 * different claim and the one that would fail silently.
 *
 * The failure being prevented: a coaching endpoint that selects from
 * `crm_call_analyses` and aggregates, because the caller already passed a
 * permission guard. It would be correct-looking, fast, and would put every call
 * a rep has not read yet into the numbers their manager quotes at them. Nothing
 * would raise. So the assertions below are about a specific row NOT being in the
 * output, not about the output existing.
 */

const ORG = "org-1";
const MANAGER = "user-manager";
const REP_A = "user-rep-a";
const REP_B = "user-rep-b";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-27T12:00:00.000Z");

const manager: CurrentUserContext = {
  userId: MANAGER,
  orgId: ORG,
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
};

interface AnalysisRow {
  organizationId: string;
  activityId: string;
  analyzerVersion: number;
  /**
   * The projected name, not the column name, and both are here on purpose.
   *
   * `CallCoachingService.digest` selects `analysedAt: callAnalyses.createdAt` —
   * the column is `created_at`, the thing the visibility rule reasons about is
   * when the analysis was made. The double below returns fixture rows verbatim
   * instead of applying the projection, so a fixture that carries only
   * `createdAt` hands the rule `undefined` and every window computation reads a
   * date that is not a date.
   *
   * Carrying both is the honest fix for a double that cannot alias: `createdAt`
   * is what the row would hold, `analysedAt` is what the query would return, and
   * `analysis()` keeps them equal so no test can drift them apart.
   */
  createdAt: Date;
  analysedAt: Date;
  talkRatioBps: number | null;
  repTurnCount: number | null;
  repQuestionCount: number | null;
  objections: { quote: string; handling: string; response: string | null }[];
  competitorMentions: { name: string; quote: string }[];
  nextStepCommitted: boolean;
}

interface ActivityRow {
  organizationId: string;
  activityId: string;
  actorUserId: string | null;
  /**
   * Required, not optional, and that is the whole reason this test file was
   * lying to itself.
   *
   * `activities.actor_kind` is NOT NULL in the schema, and
   * `call-analysis-visibility.service.ts` reads the rep as
   * `actorKind === "human" ? actorUserId : null` — a machine-sent activity has
   * an actor and is nobody's call to be embargoed over. When the fixture omitted
   * the field every row arrived as `undefined`, so every analysis resolved to
   * `repUserId: null` and took the `unattributed` branch: visible to everyone.
   *
   * Every test in this file passed under that, because "visible" is what they
   * assert about released calls. The single test that asserts something is NOT
   * visible is the one that failed, which is the only reason the hole was found
   * at all. Making the field mandatory is what stops the fixture drifting back
   * into agreeing with itself.
   */
  actorKind: ActivityActorKind;
}

/** See `call-analysis-release.spec.ts` for why only these two shapes are walked. */
function paramValues(clause: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["queryChunks"])) {
      for (const chunk of record["queryChunks"]) walk(chunk);
      return;
    }
    if ("value" in record && "encoder" in record) found.push(record["value"]);
  };
  walk(clause);
  return found;
}

/**
 * The organisation predicate is checked on every read rather than assumed.
 * A double that ignored it would report tenant isolation working on a query that
 * had none — and what leaks out of this table is what a named customer said.
 */
function makeDb(analyses: AnalysisRow[], calls: ActivityRow[]) {
  const orgsAsked: unknown[] = [];

  const rowsFor = (table: unknown, clause: unknown): unknown[] => {
    orgsAsked.push(paramValues(clause)[0]);
    const org = paramValues(clause)[0];
    if (table === callAnalyses)
      return analyses.filter((row) => row.organizationId === org);
    if (table === activities)
      return calls.filter((row) => row.organizationId === org);
    // No releases in any fixture here: every visible row below is visible
    // because its window elapsed, so nothing in this file can pass by accident
    // on a release the digest should not have been consulting.
    if (table === callAnalysisReleases) return [];
    throw new Error("unexpected table read by the coaching digest");
  };

  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation((table: unknown) => ({
        where: jest.fn().mockImplementation((clause: unknown) => {
          const rows = rowsFor(table, clause);
          return {
            orderBy: () => ({ limit: async () => rows }),
            limit: async () => rows,
            then: (resolve: (value: unknown[]) => unknown) =>
              Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),
  };

  return { db: db as unknown as Db, orgsAsked };
}

const analysis = (
  over: Partial<AnalysisRow> & { activityId: string },
): AnalysisRow => {
  const row = {
    organizationId: ORG,
    analyzerVersion: 1,
    createdAt: new Date(NOW.getTime() - 48 * HOUR),
    talkRatioBps: 5200,
    repTurnCount: 10,
    repQuestionCount: 3,
    objections: [],
    competitorMentions: [],
    nextStepCommitted: false,
    ...over,
  };
  // The projection the digest performs, applied here because the double cannot.
  return { ...row, analysedAt: row.analysedAt ?? row.createdAt };
};

function build(analyses: AnalysisRow[], calls: ActivityRow[]) {
  const { db, orgsAsked } = makeDb(analyses, calls);
  const access = { holds: jest.fn().mockResolvedValue(true) };
  const visibility = new CallAnalysisVisibilityService(
    db,
    access as unknown as AccessService,
  );
  return { orgsAsked, service: new CallCoachingService(db, visibility) };
}

describe("the coaching digest", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * A cohort of settled calls plus one analysed an hour ago. The fresh one is
   * another rep's and is still in their private window, so it must not touch a
   * single number a manager reads — not the bands, not the objection counts, not
   * the competitor list, not the next-step rate.
   */
  it("leaves an analysis the rep has not seen out of every metric", async () => {
    const settled = Array.from(
      { length: COACHING_MIN_COHORT },
      (_unused, index) => analysis({ activityId: `act-old-${index}` }),
    );
    const fresh = analysis({
      activityId: "act-fresh",
      createdAt: new Date(NOW.getTime() - HOUR),
      talkRatioBps: 9100,
      repTurnCount: 20,
      repQuestionCount: 0,
      objections: [
        {
          quote: "Your price is absurd",
          handling: "unaddressed",
          response: null,
        },
      ],
      competitorMentions: [{ name: "Acme", quote: "we already use Acme" }],
      nextStepCommitted: true,
    });

    const { service } = build(
      [...settled, fresh],
      [
        ...settled.map((row) => ({
          organizationId: ORG,
          activityId: row.activityId,
          actorUserId: REP_A,
          actorKind: "human" as const,
        })),
        {
          organizationId: ORG,
          activityId: "act-fresh",
          actorUserId: REP_B,
          actorKind: "human" as const,
        },
      ],
    );

    const result = await service.digest(manager, 30);

    expect(result.digest.cohort).toBe(COACHING_MIN_COHORT);
    expect(result.digest.embargoed).toBe(1);
    expect(result.digest.competitors).toEqual([]);
    expect(result.digest.nextStepCommittedBps).toBe(0);
    expect(result.digest.objectionHandling?.unaddressed).toBe(0);
    expect(
      result.digest.talkRatio?.find((band) => band.label === "over-80pct")
        ?.calls,
    ).toBe(0);
  });

  /**
   * The verbatim quote is the thing that must never arrive. `CoachableAnalysis`
   * has no field for it, so this walks the whole serialised result to prove the
   * mapping at the service boundary is what feeds the digest — a projection that
   * passed the jsonb straight through would still typecheck at the call site if
   * the interface ever grew a passthrough field.
   */
  it("carries no line a customer said into the manager's response", async () => {
    const rows = Array.from({ length: COACHING_MIN_COHORT }, (_unused, index) =>
      analysis({
        activityId: `act-${index}`,
        objections: [
          {
            quote: "We were burned by a vendor like you",
            handling: "answered",
            response: "I hear that",
          },
        ],
        competitorMentions: [
          { name: "Acme", quote: "we already use Acme everywhere" },
        ],
      }),
    );

    const { service } = build(
      rows,
      rows.map((row) => ({
        organizationId: ORG,
        activityId: row.activityId,
        actorUserId: REP_A,
        actorKind: "human" as const,
      })),
    );

    const serialised = JSON.stringify(await service.digest(manager, 30));

    expect(serialised).not.toContain("burned by a vendor");
    expect(serialised).not.toContain("I hear that");
    expect(serialised).not.toContain("we already use Acme");
    // The rival's name survives; the line that named them does not.
    expect(serialised).toContain("Acme");
  });

  /**
   * An analysis whose call is gone from the timeline. The per-call route already
   * refuses to serve it, so it must not appear in the numbers a manager is asked
   * to act on either — and it is dropped rather than counted as withheld,
   * because it is not being withheld from anybody.
   */
  it("drops an analysis whose call is no longer on the timeline", async () => {
    const rows = Array.from({ length: COACHING_MIN_COHORT }, (_unused, index) =>
      analysis({ activityId: `act-${index}` }),
    );
    const orphan = analysis({ activityId: "act-deleted" });

    const { service } = build(
      [...rows, orphan],
      rows.map((row) => ({
        organizationId: ORG,
        activityId: row.activityId,
        actorUserId: REP_A,
        actorKind: "human" as const,
      })),
    );

    const result = await service.digest(manager, 30);

    expect(result.digest.cohort).toBe(COACHING_MIN_COHORT);
    expect(result.digest.embargoed).toBe(0);
  });

  it("asks every read for this organisation and no other", async () => {
    const rows = [analysis({ activityId: "act-1" })];
    const { service, orgsAsked } = build(rows, [
      {
        organizationId: ORG,
        activityId: "act-1",
        actorUserId: REP_A,
        actorKind: "human" as const,
      },
    ]);

    await service.digest(manager, 30);

    expect(orgsAsked.length).toBeGreaterThanOrEqual(3);
    for (const org of orgsAsked) expect(org).toBe(ORG);
  });

  it("clamps a period nobody validated instead of building an invalid date", async () => {
    const { service } = build([], []);

    const result = await service.digest(manager, Number.NaN);

    expect(result.sinceDays).toBe(30);
    expect(Number.isNaN(result.since.getTime())).toBe(false);
  });
});
