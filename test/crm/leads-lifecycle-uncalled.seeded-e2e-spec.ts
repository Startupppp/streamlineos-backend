import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { orgModules } from "src/db/schema";
import { businessParties, leadPartyMap } from "src/db/schema/party";
import { crmLeadTouchpoints } from "src/db/schema/crm/attribution";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-UNCALLED-ROUTE-COVERAGE. The four uncalled lead-lifecycle routes.
 *
 * The 2026-09-09 inventory listed all four — verify, reject, merge and
 * custom-data — and declined to prune them, on the grounds that they are the
 * qualification workflow rather than vestigial verbs and their absence from
 * the UI reads as a screen not yet built. That reasoning stands. What it left
 * behind is a workflow with no screen and no behavioural test, only the
 * `leads-extended.controller.e2e-spec.ts` authorisation table which lists them
 * by path and method and asserts nothing about what they do.
 *
 * They rank below consent and identity but above every read, because each one
 * writes to a customer record and two of them are terminal: `reject` puts a
 * lead in LOST, and `merge` puts the *other* lead in LOST and stamps a note on
 * it saying it is a duplicate. Getting the direction of that merge wrong
 * destroys the record the operator meant to keep.
 *
 * The leads are created over HTTP through `POST /leads` rather than inserted,
 * because a lead is not a row: `createMirroredLead` writes a party and a map
 * entry, and a hand-inserted `businessParties` row would be invisible to
 * `loadLeadView` and every assertion here would pass against nothing.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=leads-lifecycle-uncalled
 */

const REP_KEYS = ["crm:leads:view", "crm:leads:create", "crm:leads:update"] as const;
/** May see the pipeline, may not move anything in it. */
const VIEWER_KEYS = ["crm:leads:view"] as const;

describe(`${SEEDED_HARNESS} the lead qualification routes nothing calls`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;

  let repToken = "";
  let viewerToken = "";
  let neighbourRepToken = "";

  let verifiableLeadId = 0;
  let rejectableLeadId = 0;
  let keeperLeadId = 0;
  let duplicateLeadId = 0;
  /** A real lead in the other tenant — what every cross-tenant probe points at. */
  let neighbourLeadId = 0;

  const http = () => request(seeded.app.getHttpServer());

  async function createLead(token: string, name: string): Promise<number> {
    const response = await http()
      .post("/leads")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `lead-create-${randomUUID()}`)
      .send({ name, source: "other", priority: "WARM" })
      .expect(201);
    const body = response.body.data ?? response.body;
    if (typeof body.id !== "number")
      throw new Error(`lead create returned no id: ${JSON.stringify(body)}`);
    return body.id;
  }

  const readLead = async (token: string, leadId: number) => {
    const response = await http()
      .get(`/leads/${leadId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return response.body.data ?? response.body;
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    /** On a plan: `leads.create` asserts the `crmLeads` ceiling before it writes. */
    fixture = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("rep", { permissionKeys: [...REP_KEYS] })
      .addMember("viewer", { permissionKeys: [...VIEWER_KEYS] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("rep", { permissionKeys: [...REP_KEYS] })
      .build();

    /** `@RequireModule("crm")` on the controller; without this row every call is 402. */
    for (const orgId of [fixture.orgId, neighbour.orgId])
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId, moduleKey: "crm", enabled: true })
        .onConflictDoNothing();

    repToken = await signSeededToken(fixture.members["rep"]!.userId, fixture.orgId);
    viewerToken = await signSeededToken(fixture.members["viewer"]!.userId, fixture.orgId);
    neighbourRepToken = await signSeededToken(
      neighbour.members["rep"]!.userId,
      neighbour.orgId,
    );

    verifiableLeadId = await createLead(repToken, "Anwesha Bhattacharya");
    rejectableLeadId = await createLead(repToken, "Timewaster Ltd");
    keeperLeadId = await createLead(repToken, "Sundaram Exports");
    duplicateLeadId = await createLead(repToken, "Sundaram Exports (dup)");
    neighbourLeadId = await createLead(neighbourRepToken, "Neighbour Prospect");
  }, 240_000);

  afterAll(async () => {
    for (const org of [fixture, neighbour]) {
      if (!org) continue;
      /**
       * The attribution touchpoint every lead creation writes.
       *
       * `crm_lead_touchpoints.lead_party_id` references `business_parties` with
       * NO ACTION, and `POST /leads` records a `first_touch` row against the
       * new party — so the party delete two statements below is refused, the
       * hook throws, and jest reports "Test suite failed to run" over ten cases
       * that had all passed. Cascading from the organisation would have taken
       * it, but that happens after the parties are gone, which is too late.
       */
      await seeded.seedDb
        .delete(crmLeadTouchpoints)
        .where(eq(crmLeadTouchpoints.orgId, org.orgId));
      /** No FK on `lead_party_map.organization_id`, so the org delete will not take it. */
      await seeded.seedDb
        .delete(leadPartyMap)
        .where(eq(leadPartyMap.organizationId, org.orgId));
      await seeded.seedDb
        .delete(businessParties)
        .where(eq(businessParties.organizationId, org.orgId));
      await org.teardown();
    }
    await seeded?.close();
  }, 60_000);

  it("verifies a lead, recording who did it and what they changed", async () => {
    const response = await http()
      .patch(`/leads/${verifiableLeadId}/verify`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({ priority: "HOT", notes: "Spoke to the buyer; budget is real." })
      .expect(200);

    const body = response.body.data ?? response.body;
    /**
     * The verifier is the token's subject. This is the whole record of the
     * verification — there is no separate `verified_at` — so if this field did
     * not land, the route would have done nothing observable at all while
     * answering 200.
     */
    expect(body.verifiedById).toBe(fixture.members["rep"]!.userId);
    expect(body.priority).toBe("HOT");
    expect(body.notes).toBe("Spoke to the buyer; budget is real.");

    /** And it survives the read the pipeline screen would do. */
    const reread = await readLead(repToken, verifiableLeadId);
    expect(reread.verifiedById).toBe(fixture.members["rep"]!.userId);
    expect(reread.priority).toBe("HOT");
  }, 120_000);

  it("verifying with an empty body records the verifier and changes nothing else", async () => {
    /**
     * `verify` applies `priority` and `notes` only when they are truthy, so an
     * empty body is the "I have checked this and it is fine" case. Asserted
     * because the alternative implementation — assigning the optional fields
     * unconditionally — would blank a lead's priority every time somebody
     * confirmed it, and would look identical from the route's signature.
     */
    const response = await http()
      .patch(`/leads/${verifiableLeadId}/verify`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({})
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.priority).toBe("HOT");
    expect(body.notes).toBe("Spoke to the buyer; budget is real.");
    expect(body.verifiedById).toBe(fixture.members["rep"]!.userId);
  }, 120_000);

  it("rejects a lead into LOST with the reason given", async () => {
    const response = await http()
      .patch(`/leads/${rejectableLeadId}/reject`)
      .set("Authorization", `Bearer ${repToken}`)
      .set("Idempotency-Key", `lead-reject-${rejectableLeadId}`)
      .send({ reason: "No budget this financial year" })
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.status).toBe("LOST");
    expect(body.lostReason).toBe("No budget this financial year");
    /** Rejecting is a form of reviewing, so it stamps the reviewer too. */
    expect(body.verifiedById).toBe(fixture.members["rep"]!.userId);
  }, 120_000);

  it("replays a reject rather than re-deciding it", async () => {
    /**
     * `@Idempotent("leads.lead.reject")`. Worth an assertion on this route
     * because the write is a blind `set` with no read-modify-write, so a
     * double delivery is invisible in the row — the replay is the only thing
     * that stops a retried request from overwriting a reason somebody has
     * since corrected.
     */
    const replay = await http()
      .patch(`/leads/${rejectableLeadId}/reject`)
      .set("Authorization", `Bearer ${repToken}`)
      .set("Idempotency-Key", `lead-reject-${rejectableLeadId}`)
      .send({ reason: "No budget this financial year" })
      .expect(200);

    expect((replay.body.data ?? replay.body).lostReason).toBe(
      "No budget this financial year",
    );

    /** Without the header at all it is a 400 that reads like body validation. */
    await http()
      .patch(`/leads/${rejectableLeadId}/reject`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({ reason: "anything" })
      .expect(400);
  }, 120_000);

  it("supplies its own reason when the caller gives none", async () => {
    const spare = await createLead(repToken, "Unexplained rejection");
    const response = await http()
      .patch(`/leads/${spare}/reject`)
      .set("Authorization", `Bearer ${repToken}`)
      .set("Idempotency-Key", `lead-reject-bare-${spare}`)
      .send({})
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.status).toBe("LOST");
    /**
     * A placeholder rather than a null, because `lost_reason` is what the loss
     * analysis groups by and a null bucket that means "somebody clicked reject"
     * is indistinguishable from one that means "we never asked".
     */
    expect(body.lostReason).toBe("Rejected during review");
  }, 120_000);

  it("replaces custom data wholesale rather than merging it", async () => {
    await http()
      .patch(`/leads/${verifiableLeadId}/custom-data`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({ customData: { region: "West", segment: "SMB" } })
      .expect(200);

    const second = await http()
      .patch(`/leads/${verifiableLeadId}/custom-data`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({ customData: { region: "South" } })
      .expect(200);

    /**
     * A replace, not a patch, despite the verb. Asserted because the two are
     * indistinguishable from a single call and the difference is whether a
     * form that renders three fields and submits the one it changed silently
     * deletes the other two.
     */
    expect((second.body.data ?? second.body).customData).toEqual({ region: "South" });
  }, 120_000);

  it("merges the duplicate away and leaves the keeper alone", async () => {
    const response = await http()
      .post(`/leads/${keeperLeadId}/merge`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({ mergeLeadId: duplicateLeadId })
      .expect(200);

    expect(response.body.data ?? response.body).toEqual({ success: true });

    /**
     * The direction is the whole risk. The lead in the path survives; the lead
     * in the body is the one marked LOST. Reversing them destroys the record
     * the operator chose to keep, and the response — a bare `{success:true}` —
     * would say nothing either way.
     */
    const loser = await readLead(repToken, duplicateLeadId);
    expect(loser.status).toBe("LOST");
    expect(loser.lostReason).toBe(`Merged with lead #${keeperLeadId}`);
    expect(loser.notes).toContain("this record is a duplicate");

    const keeper = await readLead(repToken, keeperLeadId);
    expect(keeper.status).not.toBe("LOST");
    expect(keeper.lostReason).toBeNull();
  }, 120_000);

  it("refuses to merge a lead with itself", async () => {
    await http()
      .post(`/leads/${keeperLeadId}/merge`)
      .set("Authorization", `Bearer ${repToken}`)
      .send({ mergeLeadId: keeperLeadId })
      .expect(400);

    const keeper = await readLead(repToken, keeperLeadId);
    expect(keeper.status).not.toBe("LOST");
  }, 120_000);

  it("reads another tenant's lead as absent on every one of the four", async () => {
    /**
     * 404, never 403.
     *
     * `leads.id` is a serial minted from one shared sequence, so ids are dense
     * and guessable across tenants. A 403 anywhere here would let a caller walk
     * the integer space and learn how many leads a competitor has and roughly
     * when each arrived.
     */
    const madeUpId = 2_000_000_000;

    for (const probe of [neighbourLeadId, madeUpId]) {
      await http()
        .patch(`/leads/${probe}/verify`)
        .set("Authorization", `Bearer ${repToken}`)
        .send({ priority: "HOT" })
        .expect(404);

      await http()
        .patch(`/leads/${probe}/reject`)
        .set("Authorization", `Bearer ${repToken}`)
        .set("Idempotency-Key", `lead-reject-cross-${probe}`)
        .send({ reason: "not mine to reject" })
        .expect(404);

      await http()
        .patch(`/leads/${probe}/custom-data`)
        .set("Authorization", `Bearer ${repToken}`)
        .send({ customData: { tampered: true } })
        .expect(404);

      /** As the loser: the keeper is ours, the duplicate is not. */
      await http()
        .post(`/leads/${keeperLeadId}/merge`)
        .set("Authorization", `Bearer ${repToken}`)
        .send({ mergeLeadId: probe })
        .expect(404);

      /** And as the keeper. */
      await http()
        .post(`/leads/${probe}/merge`)
        .set("Authorization", `Bearer ${repToken}`)
        .send({ mergeLeadId: keeperLeadId })
        .expect(404);
    }

    /** Their lead is exactly as they left it. */
    const theirs = await readLead(neighbourRepToken, neighbourLeadId);
    expect(theirs.status).not.toBe("LOST");
    expect(theirs.verifiedById).toBeNull();
    expect(theirs.customData ?? null).not.toEqual({ tampered: true });
  }, 120_000);

  it("refuses all four to a member who may only look", async () => {
    await http()
      .patch(`/leads/${verifiableLeadId}/verify`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ priority: "COLD" })
      .expect(403);

    await http()
      .patch(`/leads/${verifiableLeadId}/reject`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .set("Idempotency-Key", `lead-reject-denied-${verifiableLeadId}`)
      .send({ reason: "should not land" })
      .expect(403);

    await http()
      .patch(`/leads/${verifiableLeadId}/custom-data`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ customData: { tampered: true } })
      .expect(403);

    await http()
      .post(`/leads/${verifiableLeadId}/merge`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ mergeLeadId: keeperLeadId })
      .expect(403);

    /** Refused, and nothing half-applied on the way to the refusal. */
    const lead = await readLead(repToken, verifiableLeadId);
    expect(lead.priority).toBe("HOT");
    expect(lead.status).not.toBe("LOST");
    expect(lead.customData).toEqual({ region: "South" });
  }, 120_000);
});
