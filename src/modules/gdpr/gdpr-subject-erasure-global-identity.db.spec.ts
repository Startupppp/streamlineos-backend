/**
 * GDPR erasure must be COMPLETE for the requesting controller and must NOT reach into
 * another controller's tenant. HEAD failed the second half, destructively.
 *
 * THE DEFECT. `anonymiseGlobalIdentity` asked "does a membership outside this org still
 * keep the identity alive?" with a read of `organization_members` issued inside the
 * ERASING org's tenant transaction. That table's policy is
 *
 *   USING ((org_id = app.current_org_id_or_null()) OR (user_id = app.current_user_id_or_null()))
 *
 * and a tenant transaction sets only `app.organization_id` — `app.user_id` is set in
 * exactly one place in this repository, `with-identity.ts:28`, and the erasure path never
 * calls it. So under a role RLS applies to, both disjuncts fail for another org's row and
 * the guard read NOTHING, for every subject, always. `public.users` carries
 * `relrowsecurity = f`, so the redaction that follows is unimpeded: a subject who belongs
 * to orgs A and B, erased from A, lost their email, name, phone and image globally, and
 * with them their ability to sign in to B. Irreversible, and attributed in the audit log
 * to org A alone.
 *
 * MEASURED against a database at journal head, for a subject holding memberships in two
 * orgs, asking from org A's tenant transaction:
 *
 *   owner (BYPASSRLS)                            → 1
 *   streamline_app, app.organization_id = A      → 0   ← the guard
 *   streamline_app, same query + app.user_id     → 1   ← withIdentity
 *   streamline_app, control read of A's own row  → 1   (the connection works)
 *
 * WHY THE EXISTING SPEC COULD NOT SEE IT. `gdpr-subject-erasure.spec.ts` hands the service
 * a fake `db` whose third `tx.select()` resolves to whatever `otherMemberRows` was set to.
 * A double answers what it was told; it has no policy, no GUC and no role, so it agreed
 * that the guard worked while the database disagreed. The claim here — "which rows does
 * this read return" — is a fact about Postgres, so it is proved against Postgres, as the
 * non-owner role, through the real `GdprSubjectErasureService`.
 *
 * BOTH DIRECTIONS ARE COVERED, because a fix that stops over-deleting and starts
 * under-deleting has only moved the compliance failure:
 *
 *   over-delete  erasing a two-org subject from A leaves the B membership AND the global
 *                users row intact — while still erasing everything of theirs inside A
 *   under-delete erasing a subject from their LAST org does still redact the users row
 *
 * plus a witness that replays HEAD's exact guard query in HEAD's exact context and shows
 * it answering "no surviving membership" for a subject who has one, so a green run of the
 * two directions above cannot be green by accident of environment.
 *
 * EVERY WRITE THE ERASURE MAKES IS ROLLED BACK. The seed graph is committed, because
 * `subjectHasSurvivingMembership` deliberately runs on its own connection and could not
 * otherwise see it; the erasure itself runs inside a transaction this spec aborts, and
 * every assertion about what it changed is made on that transaction before the abort.
 * `audit_logs` is append-only at the database boundary (`app.prevent_audit_log_mutation`),
 * so an audit row this spec committed could never be cleaned up again.
 *
 *   GDPR_DB_TESTS=1 \
 *   APP_DATABASE_URL="postgresql://streamline_app:…@localhost:5432/scratch_head_1010" \
 *   DATABASE_URL="postgresql://tarunchintakunta@localhost:5432/scratch_head_1010" \
 *   PGSSLMODE=disable TZ=Asia/Kolkata \
 *     npx jest --runInBand --testPathPattern="gdpr-subject-erasure-global-identity.db"
 */
jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// The namespace is what `drizzle(client, { schema })` needs to produce a value of type
// `Db`. No CRM identity table is referenced here — only users, organizations,
// organization_members and organization_people.
// eslint-disable-next-line no-restricted-imports -- namespace needed for the Db type; no CRM identity table is referenced here
import * as schema from "../../db/schema";
import { organizationMembers, organizationPeople, users } from "../../db/schema";
import { createTenantAwareDb } from "../../common/tenant/tenant-db";
import { runWithTenantContext } from "../../common/tenant/tenant-context";
import { withIdentity } from "../../common/tenant/with-identity";
import type { CacheService } from "../../common/cache/cache.service";
import type { SessionsService } from "../sessions/sessions.service";
import type { GdprStoragePurgeService } from "./gdpr-storage-purge.service";
import { GdprSubjectErasureService, type SubjectErasureResult } from "./gdpr-subject-erasure.service";
import {
  ERASED_NAME,
  hashSubjectId,
  subjectHasSurvivingMembership,
} from "./gdpr-subject-erasure-identity";

const ENABLED = process.env.GDPR_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;
if (ENABLED) jest.setTimeout(180_000);

const suffix = randomUUID().slice(0, 8);
const ORG_A = `gdpr-a-${suffix}`;
const ORG_B = `gdpr-b-${suffix}`;
/** Belongs to A and B. Erasing from A must not touch their global identity. */
const MULTI = `gdpr-multi-${suffix}`;
/** Belongs to A alone. Erasing from A must redact their global identity. */
const SOLO = `gdpr-solo-${suffix}`;
const ACTOR = `gdpr-actor-${suffix}`;

const MULTI_EMAIL = `${MULTI}@erasure-probe.invalid`;
const SOLO_EMAIL = `${SOLO}@erasure-probe.invalid`;
const REAL_NAME = "Given Family";
const REAL_PHONE = "+91-99999-00000";

/** Marks the deliberate abort that keeps this spec's writes out of the database. */
const ROLLBACK = "gdpr-erasure-probe-rollback";

interface ErasureObservation {
  result: SubjectErasureResult;
  identity: { email: string; name: string | null; firstName: string | null; phone: string | null } | undefined;
  person: { firstName: string; workEmail: string | null; phone: string | null } | undefined;
}

describeDb("GDPR erasure — a multi-org subject keeps their global identity", () => {
  let owner: ReturnType<typeof postgres>;
  let appClient: ReturnType<typeof postgres>;
  let base: ReturnType<typeof drizzle<typeof schema>>;
  let appDb: ReturnType<typeof createTenantAwareDb>;
  let revokeAllForUser: jest.Mock;
  let service: GdprSubjectErasureService;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;
    if (!ownerUrl || !appUrl)
      throw new Error(
        "GDPR_DB_TESTS needs DATABASE_URL (owner, for the seed graph) and APP_DATABASE_URL (the RLS role)",
      );

    owner = postgres(ownerUrl, { prepare: false, max: 2, connect_timeout: 30 });
    // The erasure holds the request's tenant transaction while `withIdentity` borrows a
    // second connection for the surviving-membership question, so one is not enough.
    appClient = postgres(appUrl, { prepare: false, max: 4, connect_timeout: 30 });
    base = drizzle(appClient, { schema });
    appDb = createTenantAwareDb(Object.assign(base, { __client: appClient }));

    // `organizations` ⇄ `organization_members` is circular and DEFERRABLE, so the whole
    // graph goes in inside one transaction with the owner pointers corrected before commit.
    await owner.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      const people: Array<{ id: string; email: string }> = [
        { id: ACTOR, email: `${ACTOR}@erasure-probe.invalid` },
        { id: MULTI, email: MULTI_EMAIL },
        { id: SOLO, email: SOLO_EMAIL },
      ];
      for (const person of people)
        await tx`
          INSERT INTO users (id, email, name, first_name, last_name, phone)
          VALUES (${person.id}, ${person.email}, ${REAL_NAME}, 'Given', 'Family', ${REAL_PHONE})`;

      for (const org of [ORG_A, ORG_B])
        await tx`
          INSERT INTO organizations (id, name, slug, owner_membership_id)
          VALUES (${org}, ${`Erasure probe ${org}`}, ${org}, 0)`;

      // The actor owns both orgs, so neither subject membership is an owner membership —
      // `trg_guard_owner_membership` would otherwise refuse the teardown.
      const memberships: Array<{ userId: string; org: string; role: string; isOwner: boolean }> = [
        { userId: ACTOR, org: ORG_A, role: "OWNER", isOwner: true },
        { userId: ACTOR, org: ORG_B, role: "OWNER", isOwner: true },
        { userId: MULTI, org: ORG_A, role: "MEMBER", isOwner: false },
        { userId: MULTI, org: ORG_B, role: "MEMBER", isOwner: false },
        { userId: SOLO, org: ORG_A, role: "MEMBER", isOwner: false },
      ];
      for (const membership of memberships) {
        const [member] = await tx<{ id: number }[]>`
          INSERT INTO organization_members (user_id, org_id, role, is_owner)
          VALUES (${membership.userId}, ${membership.org}, ${membership.role}, ${membership.isOwner})
          RETURNING id`;
        if (membership.isOwner)
          await tx`
            UPDATE organizations SET owner_membership_id = ${member?.id ?? 0}
             WHERE id = ${membership.org}`;
      }

      // The org-scoped half of the erasure needs something to erase, so "the identity
      // survived" cannot come back green because nothing ran at all.
      for (const subject of [MULTI, SOLO])
        await tx`
          INSERT INTO organization_people
            (organization_person_id, organization_id, user_id, first_name, last_name, work_email, phone)
          VALUES (${`op-${subject}`}, ${ORG_A}, ${subject}, 'Given', 'Family',
                  ${`${subject}@erasure-probe.invalid`}, ${REAL_PHONE})`;
    });

    revokeAllForUser = jest.fn().mockResolvedValue({ revokedCount: 0 });
    service = new GdprSubjectErasureService(
      appDb,
      // `bustMembershipStatusCache` is mocked above so the cache handle is never touched,
      // and object storage is not what is under test here.
      {} as unknown as CacheService,
      { revokeAllForUser } as unknown as SessionsService,
      {
        buildManifest: jest.fn().mockResolvedValue({ blocked: false, keys: [] }),
        purgeFromManifest: jest.fn().mockResolvedValue({
          blocked: false,
          dryRun: false,
          deleted: [],
          skipped: [],
          failed: [],
          manifest: [],
        }),
      } as unknown as GdprStoragePurgeService,
    );
  }, 180_000);

  afterAll(async () => {
    if (owner) {
      // Only the committed seed graph needs removing: everything the erasure wrote was
      // aborted. Deleting the organization cascades its memberships, and the owner-membership
      // trigger reads a row that is already gone, so it does not fire.
      await owner`DELETE FROM organization_people WHERE organization_id IN (${ORG_A}, ${ORG_B})`;
      await owner`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
      await owner`DELETE FROM users WHERE id IN (${ACTOR}, ${MULTI}, ${SOLO})`;
      await owner.end({ timeout: 5 });
    }
    if (appClient) await appClient.end({ timeout: 5 });
  }, 60_000);

  /**
   * The context a `POST /gdpr/erasure/:subjectId` handler runs in — `TenantContextInterceptor`
   * opens one tenant transaction per request and publishes it so the `DRIZZLE` proxy routes
   * to it — and then aborts, so nothing this spec writes survives.
   */
  async function inAbortedTenantRequest<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    let captured: { value: T } | undefined;
    await base
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.organization_id', ${orgId}, true)`);
        captured = {
          value: await runWithTenantContext({ orgId, audience: "INTERNAL", tx }, fn),
        };
        throw new Error(ROLLBACK);
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
      });
    if (!captured) throw new Error("the tenant transaction aborted before the probe returned");
    return captured.value;
  }

  /** Erases `subject` from org A and reports what the aborted transaction saw afterwards. */
  async function eraseAndObserve(subject: string): Promise<ErasureObservation> {
    return inAbortedTenantRequest(ORG_A, async () => {
      const result = await service.eraseSubject(subject, ORG_A, ACTOR, { dryRun: false });

      // Read back on the same transaction: these rows are not committed, and `users` has no
      // policy of its own, so this is the only handle that can see the erasure's effect.
      const [identity] = await appDb
        .select({
          email: users.email,
          name: users.name,
          firstName: users.firstName,
          phone: users.phone,
        })
        .from(users)
        .where(eq(users.id, subject))
        .limit(1);
      const [person] = await appDb
        .select({
          firstName: organizationPeople.firstName,
          workEmail: organizationPeople.workEmail,
          phone: organizationPeople.phone,
        })
        .from(organizationPeople)
        .where(
          and(
            eq(organizationPeople.organizationId, ORG_A),
            eq(organizationPeople.userId, subject),
          ),
        )
        .limit(1);

      return { result, identity, person };
    });
  }

  it("connects as a role RLS actually applies to", async () => {
    // Anti-vacuity. As an owner with rolbypassrls the guard read below cannot come back
    // empty, so every assertion in this file would pass on the wrong role for the wrong
    // reason. Refuse to report green on a connection that cannot see the hazard.
    const [role] = await appClient<{ rolbypassrls: boolean }[]>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role?.rolbypassrls).toBe(false);
  });

  it("HEAD's guard cannot see the surviving membership it exists to find; withIdentity can", async () => {
    const predicate = and(
      eq(organizationMembers.userId, MULTI),
      ne(organizationMembers.orgId, ORG_A),
    );

    // This IS the pre-fix query, on the pre-fix handle: `appDb` is the tenant-aware proxy
    // the service holds, so inside the request it resolves to the tenant transaction.
    const [blind, viaHelper] = await inAbortedTenantRequest(ORG_A, async () => [
      await appDb.select({ id: organizationMembers.id }).from(organizationMembers).where(predicate).limit(1),
      await subjectHasSurvivingMembership(appDb, { orgId: ORG_A, subjectUserId: MULTI }),
    ]);
    expect(blind).toHaveLength(0);

    // The shipped helper, called from that same context, answers correctly.
    expect(viaHelper).toBe(true);

    // And so does the raw question under `withIdentity`, which is what the helper wraps.
    const sighted = await withIdentity(base, MULTI, (tx) =>
      tx.select({ id: organizationMembers.id }).from(organizationMembers).where(predicate).limit(1),
    );
    expect(sighted).toHaveLength(1);
  });

  /**
   * The under-erasure half. Stopping the over-erasure is only half a compliance duty:
   * a predicate that counts ANY row in another org answers "still a member" for someone
   * who left that org years ago, so their shared email and name survive an erasure
   * permanently. It is also symmetric — if both orgs erase the subject, each sees the
   * other's tombstone and NEITHER redacts, so `users` is never redacted by anyone.
   *
   * `membership_status` is INVITED | ACTIVE | SUSPENDED | LEFT and leaving is a
   * tombstone UPDATE, not a delete, so every one of these is reachable in production.
   */
  describe.each([
    ["LEFT", "LEFT", false, "they left that org — a tombstone, not a membership"],
    ["INVITED", "INVITED", false, "the invitation was never accepted"],
    ["SUSPENDED", "SUSPENDED", true, "suspension is reversible and that org can restore them"],
  ])("a subject whose only other membership is %s", (_label, status, survives, why) => {
    beforeEach(async () => {
      await owner`
        UPDATE organization_members SET status = ${status}::membership_status
         WHERE user_id = ${MULTI} AND org_id = ${ORG_B}`;
    });
    afterEach(async () => {
      await owner`
        UPDATE organization_members SET status = 'ACTIVE'::membership_status
         WHERE user_id = ${MULTI} AND org_id = ${ORG_B}`;
    });

    it(`${survives ? "keeps" : "does not keep"} the global identity alive, because they ${why}`, async () => {
      const held = await inAbortedTenantRequest(ORG_A, () =>
        subjectHasSurvivingMembership(appDb, { orgId: ORG_A, subjectUserId: MULTI }),
      );
      expect(held).toBe(survives);
    });
  });

  it("does not count a membership in a soft-deleted organization", async () => {
    await owner`UPDATE organizations SET deleted_at = now() WHERE id = ${ORG_B}`;
    try {
      const held = await inAbortedTenantRequest(ORG_A, () =>
        subjectHasSurvivingMembership(appDb, { orgId: ORG_A, subjectUserId: MULTI }),
      );
      expect(held).toBe(false);
    } finally {
      await owner`UPDATE organizations SET deleted_at = NULL WHERE id = ${ORG_B}`;
    }
  });

  it("erasing from org A leaves the org B membership and the global identity intact", async () => {
    const { result, identity, person } = await eraseAndObserve(MULTI);

    expect(result.blocked).toBe(false);
    expect(result.globalIdentityAnonymised).toBe(false);
    expect(result.tablesAnonymised).not.toContain("users");

    // The shared identity is untouched. This is the P0.
    expect(identity?.email).toBe(MULTI_EMAIL);
    expect(identity?.name).toBe(REAL_NAME);
    expect(identity?.firstName).toBe("Given");
    expect(identity?.phone).toBe(REAL_PHONE);

    // Anti-vacuity for this direction: the erasure DID run, and org A's copy is gone. Without
    // this, "the identity survived" would also be green for an erasure that did nothing.
    expect(result.tablesAnonymised).toContain("organization_people");
    expect(person?.firstName).toBe(ERASED_NAME);
    expect(person?.workEmail).toBeNull();
    expect(person?.phone).toBeNull();

    // The other controller's tenant still holds them.
    const [membership] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM organization_members
       WHERE user_id = ${MULTI} AND org_id = ${ORG_B}`;
    expect(membership?.n).toBe(1);

    // Sessions are global and are still revoked: the subject re-authenticates into org B
    // with fresh state rather than keeping a token minted before the erasure.
    expect(revokeAllForUser).toHaveBeenCalledWith(MULTI);
  });

  it("erasing from the last remaining org does still redact the global identity", async () => {
    // The other half of the compliance duty. A fix that only stopped over-deleting would
    // leave the subject's identity alive after their final controller erased them.
    const { result, identity } = await eraseAndObserve(SOLO);

    expect(result.globalIdentityAnonymised).toBe(true);
    expect(result.tablesAnonymised).toContain("users");
    expect(identity?.email).toBe(`erased-${hashSubjectId(SOLO)}@erased.invalid`);
    expect(identity?.name).toBe(ERASED_NAME);
    expect(identity?.firstName).toBe(ERASED_NAME);
    expect(identity?.phone).toBeNull();
  });
});
