import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import {
  customFieldDefinitions,
  kbCategories,
  kbPages,
  kbSpaces,
  orgModules,
} from "src/db/schema";
import { businessParties, contactPartyMap } from "src/db/schema/party";
import { BooksService } from "src/modules/accounting/kernel/books.service";
import { runWithTenantContext, withTenant } from "src/common/tenant";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * The remaining dead conflict handlers, one record type at a time.
 *
 * Grouped into one suite rather than five because they share a fixture and the
 * app boot is the expensive part; each case names the index it is about, and
 * each is a real duplicate write through HTTP down to Postgres. The bug in all
 * of them is the same: `err.code === "23505"` against the value Drizzle threw,
 * which keeps the SQLSTATE on `.cause`, so the handler never fired and a
 * duplicate answered 500.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=records-conflicts
 */
describe(`${SEEDED_HARNESS} a duplicate business record is a 409, not a 500`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";
  let orgId = "";
  let repUserId = "";
  let contactId = 0;
  let spaceId = 0;

  const api = () => request(seeded.app.getHttpServer());

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("owner", { standing: "OWNER" })
      .addMember("rep", {
        permissionKeys: [
          "crm:commission-plans:manage",
          "crm:commission-plans:view",
          "crm:contacts:manage",
          "crm:contacts:view",
          "support:settings:manage",
          "support:kb:manage",
          "accounting:accounts:create",
          "accounting:accounts:read",
          "kb:articles:create",
          "kb:articles:view",
        ],
      })
      .build();
    orgId = fixture.orgId;
    repUserId = fixture.members["rep"]!.userId;
    token = await signSeededToken(seeded, repUserId, orgId);

    for (const moduleKey of ["crm", "support", "accounting"]) {
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId, moduleKey, enabled: true })
        .onConflictDoNothing();
    }

    /**
     * A contact is a party plus the map row carrying the numeric id URLs still
     * speak — `assertContactAccess` joins exactly those two and 404s without
     * them. The legacy `contacts` table is not written; nothing mirrors into it
     * on this path.
     */
    const partyId = randomUUID();
    await seeded.seedDb
      .insert(businessParties)
      .values({ partyId, organizationId: orgId, name: "Dead Catch Contact" });
    const [mapped] = await seeded.seedDb
      .insert(contactPartyMap)
      .values({ organizationId: orgId, partyId })
      .returning({ contactId: contactPartyMap.contactId });
    contactId = mapped!.contactId;

    const [space] = await seeded.seedDb
      .insert(kbSpaces)
      .values({
        orgId,
        name: "Handbook",
        slug: `handbook-${orgId.slice(0, 8)}`,
        type: "company",
        defaultVisibility: "org",
      })
      .returning({ id: kbSpaces.id });
    spaceId = space!.id;

    /** `POST /accounting/accounts` resolves the org's default book first. */
    await withTenant(seeded.seedDb, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx, afterCommit: [] }, () =>
        seeded.app.get(BooksService).enable(orgId, repUserId, { countryCode: "IN" }),
      ),
    );
  }, 180000);

  afterAll(async () => {
    await seeded.seedDb
      .delete(customFieldDefinitions)
      .where(eq(customFieldDefinitions.orgId, orgId));
    await seeded.seedDb.delete(kbCategories).where(eq(kbCategories.orgId, orgId));
    await seeded.seedDb.delete(kbPages).where(eq(kbPages.orgId, orgId));
    await seeded.seedDb.delete(kbSpaces).where(eq(kbSpaces.orgId, orgId));
    await fixture.teardown();
    await seeded.close();
  });

  /** `uniq_crm_commission_plans_org_name` — (org_id, name). */
  it("refuses a second commission plan with the same name, and names it", async () => {
    const body = {
      name: "Field sales 2026",
      currency: "INR",
      effectiveFrom: "2026-01-01",
      rules: {
        basis: "deal_value",
        period: "QUARTER",
        tiers: [{ from: 0, rateBps: 500 }],
      },
    };
    const create = () =>
      api()
        .post("/crm/commission/plans")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", randomUUID())
        .send(body);

    const first = await create();
    expect(first.status).toBe(201);

    const second = await create();
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      'A commission plan named "Field sales 2026" already exists',
    );
  });

  /**
   * `uniq_crm_commission_assignments_open` — (org_id, user_id) WHERE
   * effective_to IS NULL. Two open assignments for one person is the rule; the
   * second is refused by the index and by nothing else.
   */
  it("refuses a second open commission assignment for the same person", async () => {
    const plan = await api()
      .post("/crm/commission/plans")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        name: `Assignment plan ${randomUUID().slice(0, 8)}`,
        currency: "INR",
        effectiveFrom: "2026-01-01",
        rules: {
          basis: "deal_value",
          period: "MONTH",
          tiers: [{ from: 0, rateBps: 400 }],
        },
      });
    expect(plan.status).toBe(201);
    const planId = plan.body.plan.planId as string;

    const assign = (effectiveFrom: string) =>
      api()
        .post(`/crm/commission/plans/${planId}/assignments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ userId: repUserId, effectiveFrom });

    const first = await assign("2026-01-01");
    expect(first.status).toBe(201);

    const second = await assign("2026-02-01");
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      "already has an open commission assignment",
    );
  });

  /**
   * `uniq_crm_contact_roles_combo` — (org_id, contact_id, entity_type,
   * entity_id, role_key), every column supplied by the caller. This is the
   * plainest of the lot: send the same body twice.
   */
  it("refuses the same contact role twice on the same entity", async () => {
    const body = { entityType: "deal", entityId: 4242, roleKey: "champion" };
    const add = () =>
      api()
        .post(`/contacts/${contactId}/roles`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);

    const first = await add();
    expect(first.status).toBe(201);

    const second = await add();
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      'This contact already holds the role "champion" on that deal',
    );
  });

  /**
   * `uniq_gl_accounts_book_code` — (book_id, code) WHERE deleted_at IS NULL.
   *
   * Two things were wrong here and only one was the SQLSTATE. The constraint
   * was matched against `error.message`, which on a DrizzleQueryError is the
   * SQL text, so the specific "code already used" message could never have been
   * chosen even with the code read correctly — the assertion below on the exact
   * wording is what pins that half.
   */
  it("refuses a second account with a code the book already uses, and says which code", async () => {
    const create = (name: string) =>
      api()
        .post("/accounting/accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "9911", name, accountType: "EXPENSE" });

    const first = await create("Dead catch expense");
    expect(first.status).toBe(201);

    const second = await create("Another expense");
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      "Account code 9911 is already used in this book",
    );
  });

  /**
   * `uniq_cfd_org_entity_project_key` — (org_id, entity_type, project_id, key).
   *
   * The service checks for the key before inserting, so a sequential duplicate
   * is answered by that check and the index only speaks when two requests pass
   * it together. Asserted as the invariant: one field created, one refused with
   * 409, never a 500. It reaches the index only when the interleaving
   * cooperates — a limitation of the test, not a claim about the code.
   */
  it("never answers 500 when two requests add the same custom field key at once", async () => {
    const key = `dead_catch_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const create = () =>
      api()
        .post("/support/custom-fields")
        .set("Authorization", `Bearer ${token}`)
        .send({ key, label: "Order number", fieldType: "text" });

    const [a, b] = await Promise.all([create(), create()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);

    expect(statuses).toEqual([201, 409]);
  });

  /**
   * `uniq_kb_articles_org_slug` — (org_id, slug).
   *
   * `create` mints a slug, inserts, and retries up to three times on a unique
   * violation, because two authors titling an article the same thing in the
   * same moment both compute the same slug and one has to take another. The
   * retry condition read `"code" in err` of the wrapper, so it was never true
   * and the loop never looped: the loser got a 500 instead of a second slug.
   *
   * Both requests must therefore succeed with DIFFERENT slugs. That is the
   * whole point of the retry, and it is not something the invariant "one wins,
   * one is refused" would ever have caught.
   */
  it("gives the second of two simultaneous same-title articles its own slug", async () => {
    const title = `Refund policy ${randomUUID().slice(0, 8)}`;
    const create = () =>
      api()
        .post("/kb/articles")
        .set("Authorization", `Bearer ${token}`)
        .send({ spaceId, title, content: "body", contentText: "body" });

    const [a, b] = await Promise.all([create(), create()]);

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 201]);
    expect(a.body.slug).not.toBe(b.body.slug);
  });

  /**
   * The counter-case for the handler this change DELETED.
   *
   * `uniq_kb_categories_org_space_slug` is (org_id, space_id, slug) and NULLS
   * DISTINCT, and this path never sets a space — so the index refuses nothing
   * and the 23505 branch that used to sit under the insert was dead twice
   * over. What actually stops a duplicate is the slug check above it, and this
   * pins that: the sequential duplicate is a 409, from the check.
   *
   * The second half is the finding the deletion exposed. Two concurrent
   * creates can BOTH succeed, because a read-then-write check is all there is
   * and no index backs it. Whether they do is a race: under load the second
   * request often reads the first's row and is refused. Pinning [201, 201]
   * made the case fail at random, so it accepts either outcome and checks
   * that the rows match the 201s. The gap itself is still pinned: closing it
   * needs a partial unique on (org_id, slug) WHERE space_id IS NULL, which is
   * a migration, and the catalogue check at the end reddens when that index
   * lands. That is the moment to tighten the race to exactly [201, 409].
   */
  it("refuses a duplicate KB category name in sequence, and not reliably in parallel", async () => {
    const create = (name: string) =>
      api()
        .post("/support/kb/categories")
        .set("Authorization", `Bearer ${token}`)
        .send({ name });

    const first = await create("Billing questions");
    expect(first.status).toBe(201);

    const second = await create("Billing questions");
    expect(second.status).toBe(409);

    const raced = `Racing ${randomUUID().slice(0, 8)}`;
    const [a, b] = await Promise.all([create(raced), create(raced)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect([[201, 201], [201, 409]]).toContainEqual(statuses);

    const rows = await seeded.seedDb
      .select({ slug: kbCategories.slug })
      .from(kbCategories)
      .where(eq(kbCategories.orgId, orgId));
    expect(rows.filter((r) => r.slug.startsWith("racing-"))).toHaveLength(
      statuses.filter((status) => status === 201).length,
    );

    const [index] = await seeded.seedDb.execute(sql`
      SELECT count(*)::int AS n FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'kb_categories'
         AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%space_id IS NULL%'`);
    expect((index as { n: number }).n).toBe(0);
  });
});
