import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  businessParties,
  crmNurtureEnrollments,
  crmNurtureSequenceSteps,
  crmNurtureSequences,
  deals,
  orgModules,
} from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P0-08. The controller e2e behind nurture enrol + list.
 *
 * The controller and its Zod schemas were real and nothing exercised them over
 * HTTP, so every promise the file comments make — strict bodies, `crm:autonomy:
 * manage` on the write and `view` on the read, a 404 rather than a 403 for
 * another tenant's identifier, a 400 rather than a 500 for a non-numeric
 * `dealId` — was an assertion about code no test had ever run.
 *
 * Two organisations throughout: an enrolment says which customer an
 * organisation is about to write to unprompted, which is exactly the sort of
 * fact that must not cross tenants, and the cross-tenant answers here are the
 * ones the service comments claim.
 *
 * Run with (both URLs, on the SAME database — `seedDb` is the owner connection
 * and the booted app is the non-owner app role):
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     test/crm/crm-nurture-enrollments.seeded-e2e-spec.ts
 */

interface EnrollmentBody {
  nurtureEnrollmentId: string;
  nurtureSequenceId: string;
  partyId: string;
  partyName: string | null;
  dealId: number | null;
  dealName: string | null;
  status: string;
  currentStep: number;
  exitReason: string | null;
  exitedAt: string | null;
}

describe(`${SEEDED_HARNESS} nurture enrol and list`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let other: SeededFixture;

  /** Holds both keys: enrolling is a `manage` action. */
  let operatorToken = "";
  /** Holds `view` only, to prove enrolling is the stronger key. */
  let reviewerToken = "";
  /** An ordinary member of the same org holding neither key. */
  let bystanderToken = "";
  /** Another tenant entirely. */
  let strangerToken = "";

  /** Active, two steps. The sequence the enrolment tests use. */
  let sequenceId = "";
  /** Created and left alone, so "activate it first" has something to refuse. */
  let draftSequenceId = "";
  /** Belongs to the other tenant; every cross-tenant probe aims here. */
  let otherOrgSequenceId = "";

  let partyId = "";
  let otherOrgPartyId = "";
  let dealId = 0;

  const DEAL_NAME = "Nurture probe — renewal";
  const PARTY_NAME = "Nurture probe";

  const key = (label: string) => `${label}-${randomUUID()}`;

  const enrol = (
    bearer: string,
    nurtureSequenceId: string,
    body: Record<string, unknown>,
    idempotencyKey: string | null = key("enrol"),
  ) => {
    const req = request(seeded.app.getHttpServer())
      .post(`/crm/autonomy/nurture/sequences/${nurtureSequenceId}/enrollments`)
      .set("Authorization", `Bearer ${bearer}`);
    /** @Idempotent makes the header mandatory; without it the route 400s. */
    if (idempotencyKey !== null) req.set("Idempotency-Key", idempotencyKey);
    return req.send(body);
  };

  const listEnrollments = (
    bearer: string,
    nurtureSequenceId: string,
    query: Record<string, string> = {},
  ) =>
    request(seeded.app.getHttpServer())
      .get(`/crm/autonomy/nurture/sequences/${nurtureSequenceId}/enrollments`)
      .set("Authorization", `Bearer ${bearer}`)
      .query(query);

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    fixture = await seedOrg(seeded.seedDb)
      .addMember("operator", {
        permissionKeys: ["crm:autonomy:view", "crm:autonomy:manage"],
      })
      .addMember("reviewer", { permissionKeys: ["crm:autonomy:view"] })
      .addMember("bystander")
      .build();

    other = await seedOrg(seeded.seedDb)
      .addMember("stranger", {
        permissionKeys: ["crm:autonomy:view", "crm:autonomy:manage"],
      })
      .build();

    for (const orgId of [fixture.orgId, other.orgId]) {
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId, moduleKey: "crm", enabled: true })
        .onConflictDoNothing();
    }

    operatorToken = await signSeededToken(fixture.members["operator"]!.userId, fixture.orgId);
    reviewerToken = await signSeededToken(fixture.members["reviewer"]!.userId, fixture.orgId);
    bystanderToken = await signSeededToken(fixture.members["bystander"]!.userId, fixture.orgId);
    strangerToken = await signSeededToken(other.members["stranger"]!.userId, other.orgId);

    partyId = randomUUID();
    await seeded.seedDb
      .insert(businessParties)
      .values({ partyId, organizationId: fixture.orgId, name: PARTY_NAME });

    otherOrgPartyId = randomUUID();
    await seeded.seedDb
      .insert(businessParties)
      .values({
        partyId: otherOrgPartyId,
        organizationId: other.orgId,
        name: "Somebody else's customer",
      });

    const [deal] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: DEAL_NAME,
        stage: "PROPOSAL",
        partyId,
        assignedToId: fixture.members["operator"]!.userId,
      })
      .returning({ id: deals.id });
    dealId = deal!.id;

    /**
     * The cadence is authored through the same controller rather than inserted,
     * because "create, add steps, activate, enrol" is the only order in which an
     * enrolment is reachable and a fixture that wrote the rows directly would
     * not have proved that.
     */
    const created = await request(seeded.app.getHttpServer())
      .post("/crm/autonomy/nurture/sequences")
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("Idempotency-Key", key("create"))
      .send({ name: `Post-demo ${randomUUID().slice(0, 8)}`, description: "Two touches" });
    expect(created.status).toBe(201);
    sequenceId = created.body.nurtureSequenceId;

    const steps = await request(seeded.app.getHttpServer())
      .put(`/crm/autonomy/nurture/sequences/${sequenceId}/steps`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("Idempotency-Key", key("steps"))
      .send({ steps: [{ waitHours: 72 }, { waitHours: 168 }] });
    expect(steps.status).toBe(200);

    const activated = await request(seeded.app.getHttpServer())
      .patch(`/crm/autonomy/nurture/sequences/${sequenceId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("Idempotency-Key", key("activate"))
      .send({ status: "active" });
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe("active");

    const draft = await request(seeded.app.getHttpServer())
      .post("/crm/autonomy/nurture/sequences")
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("Idempotency-Key", key("create-draft"))
      .send({ name: `Unfinished ${randomUUID().slice(0, 8)}` });
    expect(draft.status).toBe(201);
    draftSequenceId = draft.body.nurtureSequenceId;

    const foreign = await request(seeded.app.getHttpServer())
      .post("/crm/autonomy/nurture/sequences")
      .set("Authorization", `Bearer ${strangerToken}`)
      .set("Idempotency-Key", key("create-foreign"))
      .send({ name: `Their cadence ${randomUUID().slice(0, 8)}` });
    expect(foreign.status).toBe(201);
    otherOrgSequenceId = foreign.body.nurtureSequenceId;
  }, 300_000);

  afterAll(async () => {
    for (const org of [fixture, other]) {
      if (!org) continue;
      await seeded.seedDb
        .delete(crmNurtureEnrollments)
        .where(eq(crmNurtureEnrollments.organizationId, org.orgId));
      await seeded.seedDb
        .delete(crmNurtureSequenceSteps)
        .where(eq(crmNurtureSequenceSteps.organizationId, org.orgId));
      await seeded.seedDb
        .delete(crmNurtureSequences)
        .where(eq(crmNurtureSequences.organizationId, org.orgId));
      await seeded.seedDb.delete(deals).where(eq(deals.orgId, org.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, org.orgId));
      await org.teardown();
    }
    await seeded?.close();
  }, 120_000);

  // ── Enrol ───────────────────────────────────────────────────────────────────

  it("refuses an enrolment carrying no Idempotency-Key", async () => {
    /**
     * `@Idempotent` makes the header mandatory, and the refusal is a 400 whose
     * message is about a header — which reads exactly like a body validation
     * failure to anybody writing a client against this route. Pinned here so the
     * next caller finds the answer in a test rather than in a debugging session.
     */
    const res = await enrol(operatorToken, sequenceId, { partyId }, null);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Idempotency-Key");

    const rows = await seeded.seedDb
      .select({ id: crmNurtureEnrollments.nurtureEnrollmentId })
      .from(crmNurtureEnrollments)
      .where(eq(crmNurtureEnrollments.organizationId, fixture.orgId));
    expect(rows).toHaveLength(0);
  }, 60_000);

  it("refuses to enrol for a reviewer who may only look", async () => {
    /**
     * Enrolling schedules autonomous messages to a customer, so it is the
     * stronger of the pair on purpose. The header is supplied, so a 403 here can
     * only be the permission.
     */
    const res = await enrol(reviewerToken, sequenceId, { partyId });
    expect(res.status).toBe(403);
  }, 60_000);

  it("refuses to enrol for a member holding neither key", async () => {
    const res = await enrol(bystanderToken, sequenceId, { partyId });
    expect(res.status).toBe(403);
  }, 60_000);

  it("refuses to list for a member holding neither key", async () => {
    /** The read is gated too — `view` is a key, not the absence of one. */
    const res = await listEnrollments(bystanderToken, sequenceId);
    expect(res.status).toBe(403);
  }, 60_000);

  it("answers 404 for another organisation's sequence, not 403", async () => {
    /**
     * A 403 would confirm the sequence exists, which turns somebody else's
     * identifier into an existence oracle over their marketing programme.
     */
    const res = await enrol(operatorToken, otherOrgSequenceId, { partyId });
    expect(res.status).toBe(404);
  }, 60_000);

  it("answers 404 for a customer belonging to another organisation", async () => {
    /**
     * The composite `(organization_id, party_id)` foreign key would refuse this
     * too, but as a 23503 surfacing as a 500. `requireParty` is what makes it the
     * 404 it is, and a 404 rather than a 403 for the same oracle reason.
     */
    const res = await enrol(operatorToken, sequenceId, { partyId: otherOrgPartyId });
    expect(res.status).toBe(404);
  }, 60_000);

  it("rejects an unknown field rather than ignoring it", async () => {
    /**
     * `.strict()` is the whole reason there is no `subject`, no `body` and no
     * `outboundClass` in this schema: a body that were merely stripped would
     * make a message-shaped payload look accepted.
     */
    const res = await enrol(operatorToken, sequenceId, {
      partyId,
      subject: "Just checking in",
    });
    expect(res.status).toBe(400);
  }, 60_000);

  it("rejects a non-numeric dealId as a 400, not a 500", async () => {
    /**
     * `crm_nurture_enrollments.deal_id` is an integer, so an unguarded value
     * reaches Postgres as a 22P02 and surfaces as a 500 — the regex on the schema
     * is what makes it the client error it is.
     */
    const res = await enrol(operatorToken, sequenceId, { partyId, dealId: "not-a-deal" });
    expect(res.status).toBe(400);
  }, 60_000);

  it("refuses to enrol anybody in a sequence that is still a draft", async () => {
    /**
     * `resolveCadence` would answer `sequence-paused` at the first wake, so the
     * enrolment would exist for days and then end for a reason nobody was told
     * at the time.
     */
    const res = await enrol(operatorToken, draftSequenceId, { partyId });
    expect(res.status).toBe(400);
  }, 60_000);

  it("enrols the customer and answers with the names the screen needs", async () => {
    const res = await enrol(operatorToken, sequenceId, { partyId, dealId: String(dealId) });

    expect(res.status).toBe(201);
    const body = res.body as EnrollmentBody;
    expect(body.nurtureSequenceId).toBe(sequenceId);
    expect(body.partyId).toBe(partyId);
    /** Resolved server-side; a screen may not render a raw identifier. */
    expect(body.partyName).toBe(PARTY_NAME);
    expect(body.dealId).toBe(dealId);
    expect(body.dealName).toBe(DEAL_NAME);
    expect(body.status).toBe("active");
    /** Nothing has been attempted yet; step 1 is next. */
    expect(body.currentStep).toBe(0);
    expect(body.exitReason).toBeNull();
    expect(body.exitedAt).toBeNull();

    const [row] = await seeded.seedDb
      .select({
        id: crmNurtureEnrollments.nurtureEnrollmentId,
        partyId: crmNurtureEnrollments.partyId,
        dealId: crmNurtureEnrollments.dealId,
        status: crmNurtureEnrollments.status,
        enrolledByUserId: crmNurtureEnrollments.enrolledByUserId,
      })
      .from(crmNurtureEnrollments)
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, fixture.orgId),
          eq(crmNurtureEnrollments.nurtureEnrollmentId, body.nurtureEnrollmentId),
        ),
      );

    expect(row?.partyId).toBe(partyId);
    expect(row?.dealId).toBe(dealId);
    expect(row?.status).toBe("active");
    /** Who put this customer into a cadence is the first question afterwards. */
    expect(row?.enrolledByUserId).toBe(fixture.members["operator"]!.userId);
  }, 60_000);

  it("answers 409 when that customer is already in a nurture sequence", async () => {
    /**
     * `uniq_crm_nurture_enrollments_live_party` is tenant-wide rather than per
     * sequence, and a fresh Idempotency-Key is deliberate: this must be the
     * constraint answering, not a replay of the previous request.
     */
    const res = await enrol(operatorToken, sequenceId, { partyId });
    expect(res.status).toBe(409);

    const rows = await seeded.seedDb
      .select({ id: crmNurtureEnrollments.nurtureEnrollmentId })
      .from(crmNurtureEnrollments)
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, fixture.orgId),
          eq(crmNurtureEnrollments.partyId, partyId),
        ),
      );
    expect(rows).toHaveLength(1);
  }, 60_000);

  // ── List ────────────────────────────────────────────────────────────────────

  it("lists the enrolment with its party and deal names", async () => {
    const res = await listEnrollments(operatorToken, sequenceId);

    expect(res.status).toBe(200);
    const rows = res.body.data as EnrollmentBody[];
    const mine = rows.find((row) => row.partyId === partyId);
    expect(mine).toBeDefined();
    expect(mine!.partyName).toBe(PARTY_NAME);
    expect(mine!.dealName).toBe(DEAL_NAME);
    expect(mine!.status).toBe("active");
    /** Cursor-paginated, because the sweep writes to this list while it is read. */
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.pagination.nextCursor).toBeNull();
  }, 60_000);

  it("lets a view-only reviewer read the list", async () => {
    /**
     * The positive half of the deny above: enrolling 403s for this token because
     * of the key it lacks, not because the reviewer cannot reach the sequence.
     */
    const res = await listEnrollments(reviewerToken, sequenceId);
    expect(res.status).toBe(200);
    expect((res.body.data as EnrollmentBody[]).some((row) => row.partyId === partyId)).toBe(true);
  }, 60_000);

  it("does not show one organisation's enrolments to another", async () => {
    /** Again 404, not 403, and not an empty 200 that would confirm the id. */
    const res = await listEnrollments(strangerToken, sequenceId);
    expect(res.status).toBe(404);

    const mirrored = await listEnrollments(operatorToken, otherOrgSequenceId);
    expect(mirrored.status).toBe(404);
  }, 60_000);

  it("lets the other tenant list its own sequence", async () => {
    /**
     * The control for the pair above: they fail because of the tenant, not
     * because the route is broken.
     */
    const res = await listEnrollments(strangerToken, otherOrgSequenceId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  }, 60_000);

  it("filters by enrolment status", async () => {
    /**
     * The status filter is the feature's own scoreboard — `replied` is the number
     * it is judged on — so a filter that silently ignored its argument would
     * report every cadence as working.
     */
    const active = await listEnrollments(operatorToken, sequenceId, { status: "active" });
    expect(active.status).toBe(200);
    expect((active.body.data as EnrollmentBody[]).some((row) => row.partyId === partyId)).toBe(
      true,
    );

    const exited = await listEnrollments(operatorToken, sequenceId, { status: "exited" });
    expect(exited.status).toBe(200);
    expect(exited.body.data).toEqual([]);
  }, 60_000);

  it("rejects an unknown query parameter and an unknown status", async () => {
    const unknownParam = await listEnrollments(operatorToken, sequenceId, { orgId: "sneaky" });
    expect(unknownParam.status).toBe(400);

    const unknownStatus = await listEnrollments(operatorToken, sequenceId, { status: "paused" });
    expect(unknownStatus.status).toBe(400);
  }, 60_000);

  it("clamps an over-large page size to the platform cap rather than refusing", async () => {
    const res = await listEnrollments(operatorToken, sequenceId, { limit: "500" });
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  }, 60_000);
});
