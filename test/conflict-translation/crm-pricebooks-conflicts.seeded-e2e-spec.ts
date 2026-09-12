import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { crmProducts, orgModules } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Pricebook and quote-template names collide for real, against a real index.
 *
 * Every case here performs a genuine duplicate write through the whole stack —
 * HTTP, guards, service, Drizzle, Postgres — and asserts the STATUS the caller
 * receives. That is the point. The defect being fixed was
 * `catch (e) { if (e.code === "23505") … }` written directly against the caught
 * value, while Drizzle puts the SQLSTATE on `.cause`; the handler therefore
 * never fired and the duplicate surfaced as an unhandled 500. A spec that mocks
 * the database and rejects with a bare `{ code: "23505" }` passes whether the
 * service reads the wrapper or the cause, which is exactly how this stayed
 * invisible. Only a real driver error can tell the two apart, and only the
 * status code says what the caller actually got.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-pricebooks-conflicts
 */
describe(`${SEEDED_HARNESS} a duplicate pricebook name is a 409, not a 500`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";
  let orgId = "";
  let productId = 0;

  const api = () => request(seeded.app.getHttpServer());

  /**
   * `POST /crm/pricebooks` is `@Idempotent("crm.pricebook.create")`, which makes
   * `Idempotency-Key` a required header — without one the interceptor answers
   * 400 before the handler runs, and a 400 in a conflict test reads like the
   * conflict never happened. A fresh key per call, so the second create is
   * refused by the unique index rather than replayed from the first's stored
   * response.
   */
  const createPricebook = (name: string) =>
    api()
      .post("/crm/pricebooks")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ name, currency: "INR", isDefault: false, isActive: true });

  const createTemplate = (name: string) =>
    api()
      .post("/crm/quote-templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, isDefault: false });

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("admin", { permissionKeys: ["crm:pricebooks:manage"] })
      .build();
    orgId = fixture.orgId;

    /** Every route on the controller carries `@RequireModule("crm")`. */
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    token = await signSeededToken(seeded, fixture.members["admin"]!.userId, orgId);

    const [product] = await seeded.seedDb
      .insert(crmProducts)
      .values({ orgId, name: "Widget", unitPrice: 1000 })
      .returning({ id: crmProducts.id });
    productId = product!.id;
  }, 120000);

  afterAll(async () => {
    await seeded.seedDb.delete(crmProducts).where(eq(crmProducts.orgId, orgId));
    await fixture.teardown();
    await seeded.close();
  });

  it("refuses a second pricebook with the same name, and names it", async () => {
    const first = await createPricebook("Standard list");
    expect(first.status).toBe(201);

    const second = await createPricebook("Standard list");
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      'A pricebook named "Standard list" already exists',
    );
  });

  it("refuses a rename onto a name another pricebook already holds", async () => {
    await createPricebook("Enterprise list");
    const other = await createPricebook("Partner list");
    expect(other.status).toBe(201);

    const renamed = await api()
      .patch(`/crm/pricebooks/${other.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Enterprise list" });

    expect(renamed.status).toBe(409);
    expect(String(renamed.body.message)).toContain(
      'A pricebook named "Enterprise list" already exists',
    );
  });

  it("refuses a second quote template with the same name, and names it", async () => {
    const first = await createTemplate("Standard quote");
    expect(first.status).toBe(201);

    const second = await createTemplate("Standard quote");
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      'A quote template named "Standard quote" already exists',
    );
  });

  it("refuses a template rename onto a name another template already holds", async () => {
    await createTemplate("Renewal quote");
    const other = await createTemplate("Upsell quote");
    expect(other.status).toBe(201);

    const renamed = await api()
      .patch(`/crm/quote-templates/${other.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renewal quote" });

    expect(renamed.status).toBe(409);
    expect(String(renamed.body.message)).toContain(
      'A quote template named "Renewal quote" already exists',
    );
  });

  /**
   * The counter-case for the branch this change DELETED rather than repaired.
   *
   * `upsertEntry` names `uniq_crm_pb_entry` as its own ON CONFLICT arbiter, so
   * the one unique a caller can collide is resolved into an update and never
   * raised — which is why a 23505 handler there was dead twice over. If a
   * future edit drops the `onConflictDoUpdate`, this reddens with a 500 and
   * that is the signal a conflict handler is genuinely needed.
   */
  it("re-prices an existing entry instead of conflicting on it", async () => {
    const pb = await createPricebook("Entry list");
    expect(pb.status).toBe(201);

    const upsert = (unitPriceCents: number) =>
      api()
        .post(`/crm/pricebooks/${pb.body.id}/entries`)
        .set("Authorization", `Bearer ${token}`)
        .send({ productId, unitPriceCents, minQuantity: 1 });

    const first = await upsert(1000);
    expect(first.status).toBe(200);

    const second = await upsert(2500);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.unitPriceCents).toBe(2500);

    const listed = await api()
      .get(`/crm/pricebooks/${pb.body.id}/entries`)
      .set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
  });
});
