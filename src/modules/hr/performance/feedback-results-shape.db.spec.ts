/**
 * The 360° feedback results panel reads four numbers this endpoint never sent.
 *
 * `frontend/hooks/api/hr/feedback.ts` declares
 *   FeedbackResult { subjectId, totalRequests, completedRequests, avgRating?, responses[] }
 * and `frontend/features/hr/feedback/results-tab.tsx` renders all four as
 * StatCards plus a completion bar. `getResults` returned
 * `{ subjectId, requests, responses }`, so every one of the four was wrong:
 * two cards rendered nothing, the third rendered "—", and `undefined > 0` is
 * false so the completion percentage was hard-coded to 0. Both repos typecheck
 * clean because each side typechecks against itself — the drift is only visible
 * on the wire.
 *
 * The half a mocked database cannot show is the WHERE clause. `requests` was
 * filtered to `status = 'COMPLETED'`, so a completion rate derived from it can
 * only ever read 100%; the fix must count every request for the subject and
 * only then narrow to the completed ones. A fake answers whatever rows it was
 * handed, which proves nothing about which rows the query asks for. So this runs
 * against a real catalog, in the house `.db.spec.ts` style, inside a transaction
 * that is rolled back — the database is left exactly as it was found.
 *
 *   DATABASE_URL=postgresql://…  \
 *     pnpm test:db-specs --testPathPattern="feedback-results-shape"
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import {
  feedbackCycles,
  feedbackCycleRequests,
  feedbackCycleResponses,
} from "../../../db/schema";
import { FeedbackService } from "./feedback.service";

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "feedback-results-shape.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

type Results = Awaited<ReturnType<FeedbackService["getResults"]>>;

interface Probe {
  /** The subject's results BEFORE any fixture row exists — the baseline. */
  before: Results;
  /** …and after three requests, two of them completed with ratings 4 and 5. */
  after: Results;
}

describe("GET /hr/feedback/results/:subjectId — wire shape", () => {
  let client: ReturnType<typeof connect>;
  let db: Db;
  let probe: Probe;

  beforeAll(async () => {
    client = connect();
    db = drizzle(client, { schema });
    probe = await runProbe();
  }, 60_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /**
   * Builds one 360° cycle for a real tenant: three requests for one subject, two
   * of them COMPLETED with overall ratings 4 and 5, one still PENDING. Reads the
   * subject through the real service before and after, then rolls everything
   * back.
   */
  async function runProbe(): Promise<Probe> {
    let captured: Probe | undefined;
    try {
      await db.transaction(async (tx) => {
        const [member] = await tx
          .select({
            orgId: schema.organizationMembers.orgId,
            userId: schema.organizationMembers.userId,
          })
          .from(schema.organizationMembers)
          .where(eq(schema.organizationMembers.status, "ACTIVE"))
          .limit(1);
        if (!member)
          throw new Error("feedback-results-shape.db.spec.ts needs one ACTIVE organization member to scope fixtures to");

        const reviewers = await tx.select({ id: schema.users.id }).from(schema.users).limit(3);
        if (reviewers.length < 3)
          throw new Error("feedback-results-shape.db.spec.ts needs three users to act as distinct reviewers");

        const service = new FeedbackService(tx);
        const before = await service.getResults(member.orgId, member.userId);

        const [cycle] = await tx
          .insert(feedbackCycles)
          .values({
            orgId: member.orgId,
            name: "results-shape probe",
            startDate: "2026-01-01",
            endDate: "2026-03-31",
          })
          .returning({ id: feedbackCycles.id });
        if (!cycle) throw new Error("fixture cycle was not inserted");

        const inserted = await tx
          .insert(feedbackCycleRequests)
          .values([
            {
              cycleId: cycle.id,
              orgId: member.orgId,
              subjectId: member.userId,
              reviewerId: reviewers[0]!.id,
              relationship: "PEER",
              status: "COMPLETED",
            },
            {
              cycleId: cycle.id,
              orgId: member.orgId,
              subjectId: member.userId,
              reviewerId: reviewers[1]!.id,
              relationship: "MANAGER",
              status: "COMPLETED",
            },
            {
              cycleId: cycle.id,
              orgId: member.orgId,
              subjectId: member.userId,
              reviewerId: reviewers[2]!.id,
              relationship: "REPORT",
              status: "PENDING",
            },
          ])
          .returning({ id: feedbackCycleRequests.id });

        await tx.insert(feedbackCycleResponses).values([
          {
            requestId: inserted[0]!.id,
            orgId: member.orgId,
            overallRating: 4,
            responses: [{ questionId: "q1", rating: 4 }],
          },
          {
            requestId: inserted[1]!.id,
            orgId: member.orgId,
            overallRating: 5,
            responses: [{ questionId: "q1", rating: 5, text: "strong" }],
          },
        ]);

        captured = { before, after: await service.getResults(member.orgId, member.userId) };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    if (!captured) throw new Error("probe did not run");
    return captured;
  }

  it("reports a subject with no feedback as zero, not as an absent field", () => {
    // Also the precondition every assertion below leans on: this subject starts
    // clean, so the fixture's three rows are the only ones being counted.
    expect(probe.before.totalRequests).toBe(0);
    expect(probe.before.completedRequests).toBe(0);
    expect(probe.before.responses).toEqual([]);
  });

  it("counts EVERY request for the subject, not only the completed ones", () => {
    expect(probe.after.totalRequests).toBe(3);
    expect(probe.after.completedRequests).toBe(2);
  });

  it("sends an average of the submitted overall ratings", () => {
    expect(probe.after.avgRating).toBeCloseTo(4.5, 5);
  });

  it("drives the panel's completion bar to the real percentage rather than 0", () => {
    // The exact arithmetic results-tab.tsx runs on the payload.
    const completionPct =
      probe.after.totalRequests > 0
        ? Math.round((probe.after.completedRequests / probe.after.totalRequests) * 100)
        : 0;
    expect(completionPct).toBe(67);
  });

  it("sends responses in the shape the client declares", () => {
    expect(probe.after.responses).toHaveLength(2);
    const sorted = [...probe.after.responses].sort(
      (a, b) => (a.overallRating ?? 0) - (b.overallRating ?? 0),
    );
    expect(sorted[0]).toEqual({
      requestId: expect.any(Number),
      overallRating: 4,
      submittedAt: expect.any(String),
      responses: [{ questionId: "q1", rating: 4 }],
    });
    expect(Number.isNaN(Date.parse(sorted[1]!.submittedAt))).toBe(false);
  });
});
