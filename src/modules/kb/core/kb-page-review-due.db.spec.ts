import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { kbPages } from "../../../db/schema";
import { hasReviewCommitment, isReviewDue } from "./kb-page-trust-predicates";

const suffix = randomUUID().slice(0, 8);
const ORG = `kbrd-${suffix}`;
const USER = `kbrd-user-${suffix}`;

const HOUR = 60 * 60 * 1000;

describe("isReviewDue — evaluated as SQL against real rows, because a predicate over three nullable columns cannot be proven by reading its text", () => {
  let owner: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  let membershipId = 0;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) {
      throw new Error(
        "kb-page-review-due.db.spec.ts requires DATABASE_URL (owner role)",
      );
    }
    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    db = drizzle(owner, { schema });

    const past = new Date(Date.now() - 24 * HOUR).toISOString();
    const future = new Date(Date.now() + 24 * HOUR).toISOString();

    const states: ReadonlyArray<
      readonly [
        string,
        "unverified" | "verified" | "verification_expired",
        string | null,
        string | null,
        number | null,
      ]
    > = [
      ["verified and current", "verified", future, future, 30],
      ["verification window lapsed", "verified", past, past, 30],
      ["edited after verification, window still open", "unverified", future, future, null],
      ["on a cadence, never verified", "unverified", null, null, 30],
      ["no verification and no commitment", "unverified", null, null, null],
      ["scheduled review arrived inside an open verification window", "verified", future, past, 30],
      ["verified with no expiry and no commitment", "verified", null, null, null],
    ];

    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email, name) VALUES (${USER}, ${`${USER}@kbrd.invalid`}, 'Review Due Seed')`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id) VALUES (${ORG}, 'Review Due Org', ${ORG}, 0)`;
      const [member] = await tx<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner)
        VALUES (${USER}, ${ORG}, 'OWNER', true) RETURNING id`;
      if (!member) throw new Error("seed: membership insert failed");
      membershipId = member.id;
      await tx`UPDATE organizations SET owner_membership_id = ${membershipId} WHERE id = ${ORG}`;

      for (const [label, trustState, verifiedUntil, nextReviewAt, interval] of states) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO kb_pages
            (org_id, title, visibility, status, created_by_id, created_by_membership_id,
             trust_state, verified_until, next_review_at, review_interval_days)
          VALUES
            (${ORG}, ${label}, 'org', 'published', ${USER}, ${membershipId},
             ${trustState}, ${verifiedUntil}, ${nextReviewAt}, ${interval})
          RETURNING id`;
        if (!row) throw new Error(`seed: insert failed for ${label}`);
        ids[label] = row.id;
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (owner) {
      await owner`DELETE FROM kb_pages WHERE org_id = ${ORG}`;
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.audit_log_detachment', 'true', true)`;
        await tx`UPDATE audit_logs SET org_id = null, actor_membership_id = null, is_platform_event = true WHERE org_id = ${ORG}`;
        await tx`DELETE FROM organizations WHERE id = ${ORG}`;
      });
      await owner`DELETE FROM users WHERE id = ${USER} AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE user_id = ${USER})`;
      await owner.end({ timeout: 5 });
    }
  }, 60_000);

  async function labelsMatching(predicate: ReturnType<typeof isReviewDue>): Promise<string[]> {
    const rows = await db
      .select({ title: kbPages.title })
      .from(kbPages)
      .where(and(eq(kbPages.orgId, ORG), predicate));
    return rows.map((r) => r.title).sort();
  }

  it("selects exactly the four due states and rejects the three that are not due, so no state falls through the predicate's NULL branches into neither result", async () => {
    const due = await labelsMatching(isReviewDue());

    expect(due).toEqual(
      [
        "edited after verification, window still open",
        "on a cadence, never verified",
        "scheduled review arrived inside an open verification window",
        "verification window lapsed",
      ].sort(),
    );
  });

  it("treats a page edited back to unverified while its old verification window is still in the future as due, which is the state that resets trust without clearing verified_until and was previously invisible to every review surface", async () => {
    const due = await labelsMatching(isReviewDue());

    expect(due).toContain("edited after verification, window still open");
    expect(due).not.toContain("verified and current");
  });

  it("treats a page whose scheduled review date arrived while it is still inside an open verification window as due, so the scheduled branch cannot be collapsed into the verified-now negation", async () => {
    const due = await labelsMatching(isReviewDue());

    expect(due).toContain("scheduled review arrived inside an open verification window");
  });

  it("leaves a page with no verification history and no cadence out of the queue, so due-ness requires a review commitment rather than merely being unverified", async () => {
    const due = await labelsMatching(isReviewDue());

    expect(due).not.toContain("no verification and no commitment");
    expect(due).not.toContain("verified with no expiry and no commitment");
  });

  it("counts every due page as also holding a review commitment, so the space health summary cannot hide a nonzero overdue count behind a zero policy count", async () => {
    const due = await labelsMatching(isReviewDue());
    const committed = await labelsMatching(hasReviewCommitment());

    for (const label of due) expect(committed).toContain(label);
  });
});
