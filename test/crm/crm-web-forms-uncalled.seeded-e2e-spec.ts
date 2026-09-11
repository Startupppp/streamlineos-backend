import { randomUUID } from "node:crypto";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { orgModules, webLeadForms } from "src/db/schema";
import { businessParties, leadPartyMap } from "src/db/schema/party";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-UNCALLED-ROUTE-COVERAGE. The four `crm/web-forms` routes no screen calls.
 *
 * These four rank high on blast radius for a reason the route list does not
 * show: they are the administration of an *unauthenticated ingress*. A row in
 * `web_lead_forms` carries a `public_token`, and `GET`/`POST
 * /public/lead-form/:token` serve that token with `@Public()` and no session.
 * Creating a form opens a door on the public internet through which anybody
 * can insert a lead into the tenant. Deactivating one closes it. Deleting one
 * closes it permanently, with a hard `DELETE` and no tombstone.
 *
 * That is also the answer to the question the audit raised. "No caller in this
 * frontend" is not evidence a route is dead: the *administration* of these
 * forms has no screen, but the surface it administers is live, reachable from
 * outside, and consumed by `src/modules/public/crm.service.ts`. Nothing in a
 * frontend grep could have told you that.
 *
 * So the spec is written as the round trip rather than as four isolated calls.
 * A create that returns a token nothing honours, or a deactivate that leaves
 * the door open, are both green under an authorisation table and both wrong.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-web-forms-uncalled
 */

const ADMIN_KEYS = ["crm:web-forms:manage"] as const;
/** Enough to be a member of the org and nothing more. */
const OUTSIDER_KEYS = ["crm:leads:view"] as const;

describe(`${SEEDED_HARNESS} the web-form routes nothing calls administer a live public door`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let neighbour: SeededFixture;

  let adminToken = "";
  let outsiderToken = "";
  let neighbourAdminToken = "";

  let formId = 0;
  let publicToken = "";
  /** A form belonging to the other tenant, for the cross-tenant probes. */
  let neighbourFormId = 0;

  const http = () => request(seeded.app.getHttpServer());

  const formRows = (orgId: string) =>
    seeded.seedDb.select().from(webLeadForms).where(eq(webLeadForms.orgId, orgId));

  const leadRows = (orgId: string) =>
    seeded.seedDb
      .select()
      .from(businessParties)
      .where(eq(businessParties.organizationId, orgId));

  beforeAll(async () => {
    seeded = await createSeededE2eApp();

    /**
     * On a plan, because `submitLeadForm` calls
     * `planLimits.assertWithinLimit(orgId, "crmLeads")` before it writes. An
     * org with no subscription resolves to the free tier, and a spec that
     * happened to trip the free lead ceiling would fail as a 402 that reads
     * like a module gate.
     */
    fixture = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("formAdmin", { permissionKeys: [...ADMIN_KEYS] })
      .addMember("outsider", { permissionKeys: [...OUTSIDER_KEYS] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("formAdmin", { permissionKeys: [...ADMIN_KEYS] })
      .build();

    /** `@RequireModule("crm")` on the controller; without this row every call is 402. */
    for (const orgId of [fixture.orgId, neighbour.orgId])
      await seeded.seedDb
        .insert(orgModules)
        .values({ orgId, moduleKey: "crm", enabled: true })
        .onConflictDoNothing();

    adminToken = await signSeededToken(seeded, fixture.members["formAdmin"]!.userId, fixture.orgId);
    outsiderToken = await signSeededToken(seeded, fixture.members["outsider"]!.userId, fixture.orgId);
    neighbourAdminToken = await signSeededToken(seeded, 
      neighbour.members["formAdmin"]!.userId,
      neighbour.orgId,
    );

    const [theirForm] = await seeded.seedDb
      .insert(webLeadForms)
      .values({
        orgId: neighbour.orgId,
        name: "Neighbour enquiry form",
        fields: [],
        publicToken: randomUUID().replace(/-/g, "").slice(0, 16),
      })
      .returning({ id: webLeadForms.id });
    neighbourFormId = theirForm!.id;
  }, 240_000);

  afterAll(async () => {
    for (const org of [fixture, neighbour]) {
      if (!org) continue;
      await seeded.seedDb.delete(webLeadForms).where(eq(webLeadForms.orgId, org.orgId));
      /** `lead_party_map.organization_id` carries no FK, so the org delete will not take it. */
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

  it("creates a form, and mints the token the public route is keyed on", async () => {
    const response = await http()
      .post("/crm/web-forms")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Website enquiry",
        description: "Footer form on the marketing site",
        fields: [
          { name: "name", label: "Your name", type: "text", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "message", label: "How can we help?", type: "textarea", required: false },
        ],
      })
      .expect(201);

    const body = response.body.data ?? response.body;
    expect(typeof body.id).toBe("number");
    expect(body.name).toBe("Website enquiry");
    /**
     * The token is the credential. Sixteen hex characters, minted server-side,
     * never supplied by the caller — a form whose token a caller could choose
     * would let one tenant claim a URL another tenant's marketing site uses.
     */
    expect(body.publicToken).toMatch(/^[0-9a-f]{16}$/);
    expect(body.isActive).toBe(true);
    /** The default the schema promises, applied when the caller sends none. */
    expect(body.submitMessage).toBe("Thank you! We'll be in touch soon.");
    expect(body.totalSubmissions).toBe(0);

    formId = body.id;
    publicToken = body.publicToken;

    const rows = await formRows(fixture.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdBy).toBe(fixture.members["formAdmin"]!.userId);
  }, 120_000);

  it("the token it minted opens a door with no session at all", async () => {
    /**
     * The assertion the create route exists for, and the one nothing had made.
     *
     * No Authorization header, deliberately. `GET /public/lead-form/:token` is
     * `@Public()`, and a create that returned a token the public route did not
     * honour would look identical from the admin side.
     */
    const view = await http().get(`/public/lead-form/${publicToken}`).expect(200);
    const form = (view.body.data ?? view.body).form;
    expect(form.name).toBe("Website enquiry");
    expect(form.fields).toHaveLength(3);
    /** The token is not echoed back through the public read; only the shape is. */
    expect(form.publicToken).toBeUndefined();

    const submitted = await http()
      .post(`/public/lead-form/${publicToken}`)
      .send({
        name: "Ilyas Rahman",
        email: "ilyas@enquiry.invalid",
        message: "Please call me about the annual plan",
      })
      .expect(200);
    expect((submitted.body.data ?? submitted.body).success).toBe(true);

    /** A lead in the right tenant — the whole point of the door being open. */
    const leads = await leadRows(fixture.orgId);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.name).toBe("Ilyas Rahman");
    expect(leads[0]!.email).toBe("ilyas@enquiry.invalid");

    const [row] = await formRows(fixture.orgId);
    expect(row!.totalSubmissions).toBe(1);
  }, 120_000);

  it("refuses a submission that omits a field the form marks required", async () => {
    /**
     * The validation is per-form and lives in `submitLeadForm`, driven by the
     * `fields` array the create route stored. So this is really an assertion
     * about the create route: had it dropped or reshaped `required`, the public
     * door would silently accept anything.
     */
    await http()
      .post(`/public/lead-form/${publicToken}`)
      .send({ name: "No address given" })
      .expect(400);

    expect(await leadRows(fixture.orgId)).toHaveLength(1);
    expect((await formRows(fixture.orgId))[0]!.totalSubmissions).toBe(1);
  }, 120_000);

  it("lists the org's own forms, and refuses a member without the key", async () => {
    const response = await http()
      .get("/crm/web-forms")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const rows = response.body.data ?? response.body;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(formId);

    /** One key gates all four routes; a member without it sees nothing. */
    await http()
      .get("/crm/web-forms")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(403);

    /** And the neighbour's list is theirs, not a view of everyone's. */
    const theirs = await http()
      .get("/crm/web-forms")
      .set("Authorization", `Bearer ${neighbourAdminToken}`)
      .expect(200);
    const theirRows = theirs.body.data ?? theirs.body;
    expect(theirRows).toHaveLength(1);
    expect(theirRows[0].id).toBe(neighbourFormId);
  }, 120_000);

  it("deactivating the form closes the public door", async () => {
    const response = await http()
      .patch(`/crm/web-forms/${formId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: false, submitMessage: "We are not taking enquiries right now." })
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.isActive).toBe(false);
    expect(body.submitMessage).toBe("We are not taking enquiries right now.");
    /** A patch is a patch: what it did not name is untouched. */
    expect(body.name).toBe("Website enquiry");
    expect(body.publicToken).toBe(publicToken);

    /**
     * The off-switch, exercised from the outside. `getLeadForm` and
     * `submitLeadForm` both reject an inactive form as *not found* rather than
     * as disabled — which is right, because "this token names a form that is
     * switched off" is more than an anonymous caller needs to know.
     */
    await http().get(`/public/lead-form/${publicToken}`).expect(404);
    await http()
      .post(`/public/lead-form/${publicToken}`)
      .send({ name: "Too late", email: "late@enquiry.invalid" })
      .expect(404);

    expect(await leadRows(fixture.orgId)).toHaveLength(1);
  }, 120_000);

  it("will not let one tenant read, edit or delete another tenant's form", async () => {
    /**
     * 404, never 403. A 403 would confirm the id names a real form somewhere,
     * and `web_lead_forms.id` is a serial — so a caller could walk the integer
     * space and count every tenant's forms. The controller checks `exists`
     * scoped by org before it writes, which is what makes the two answers
     * indistinguishable.
     */
    const madeUpId = 2_000_000_000;

    for (const probe of [neighbourFormId, madeUpId]) {
      await http()
        .patch(`/crm/web-forms/${probe}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(404);

      await http()
        .delete(`/crm/web-forms/${probe}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);
    }

    /** Their form is untouched, and still switched on. */
    const [theirForm] = await formRows(neighbour.orgId);
    expect(theirForm!.isActive).toBe(true);
  }, 120_000);

  it("deletes the form outright, and the token stops naming anything", async () => {
    await http()
      .delete(`/crm/web-forms/${formId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(204);

    /**
     * A hard delete with no tombstone. Asserted rather than assumed because it
     * is the difference between a door that can be reopened and one that
     * cannot: `public_token` is globally unique, the row is gone, and the
     * submissions counter goes with it. Anything already published pointing at
     * this URL is now a dead link, permanently.
     */
    expect(await formRows(fixture.orgId)).toHaveLength(0);

    await http().get(`/public/lead-form/${publicToken}`).expect(404);

    /** The leads it collected outlive it — they are customer records, not form state. */
    expect(await leadRows(fixture.orgId)).toHaveLength(1);
  }, 120_000);
});
