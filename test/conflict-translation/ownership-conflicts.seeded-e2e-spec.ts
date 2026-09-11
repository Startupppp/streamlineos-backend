import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { moduleOwnerships, orgModules, ownershipTransfers, roles } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * A second pending hand-over is a 409, and nothing else was ever going to say so.
 *
 * `ownership_transfers` carries two partial uniques —
 * `uniq_ownership_xfers_org_pending_org` on (org_id) and
 * `uniq_ownership_xfers_org_pending_module` on (org_id, module_key), both
 * WHERE status = 'PENDING' — and neither initiation path looks for an existing
 * pending transfer before inserting. The index IS the guard, and the handler
 * translating it read `err.code` off the value Drizzle threw, which carries the
 * SQLSTATE on `.cause`. So the one rule keeping two people from being handed
 * the same organisation at once answered 500.
 *
 * The three transfer cases below are deterministic: initiate, then initiate
 * again. The two group-name cases are not, and say so where they stand.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=ownership-conflicts
 */
describe(`${SEEDED_HARNESS} a second pending ownership transfer is a 409, not a 500`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let ownerToken = "";
  let orgId = "";
  let ownerMembershipId = 0;
  let heirMembershipId = 0;
  let heirUserId = "";
  let spareMembershipId = 0;

  const api = () => request(seeded.app.getHttpServer());

  const clearTransfers = () =>
    seeded.seedDb.delete(ownershipTransfers).where(eq(ownershipTransfers.orgId, orgId));

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("owner", { standing: "OWNER" })
      .addMember("heir")
      .addMember("spare")
      .build();
    orgId = fixture.orgId;
    ownerMembershipId = fixture.members["owner"]!.membershipId;
    heirMembershipId = fixture.members["heir"]!.membershipId;
    heirUserId = fixture.members["heir"]!.userId;
    spareMembershipId = fixture.members["spare"]!.membershipId;
    ownerToken = await signSeededToken(fixture.members["owner"]!.userId, orgId);

    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();

    /** Both module paths read the current owner first and 404 without it. */
    await seeded.seedDb
      .insert(moduleOwnerships)
      .values({ orgId, moduleKey: "crm", ownerMembershipId })
      .onConflictDoNothing();
  }, 120000);

  afterAll(async () => {
    await clearTransfers();
    await seeded.seedDb.delete(moduleOwnerships).where(eq(moduleOwnerships.orgId, orgId));
    await seeded.seedDb.delete(roles).where(eq(roles.orgId, orgId));
    await fixture.teardown();
    await seeded.close();
  });

  it("refuses a second pending org ownership transfer", async () => {
    await clearTransfers();

    const initiate = (toMembershipId: number) =>
      api()
        .post("/ownership/org/transfer")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ toMembershipId, expiresInHours: 48 });

    const first = await initiate(heirMembershipId);
    expect(first.status).toBe(201);

    /**
     * A different recipient on purpose. Naming the same one could be refused
     * by some other rule and still read as this one passing; the index is
     * about there being a pending hand-over at all, not about who receives it.
     */
    const second = await initiate(spareMembershipId);
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      "A pending org ownership transfer already exists",
    );
  });

  it("refuses a second pending module ownership transfer", async () => {
    await clearTransfers();

    const initiate = (toMembershipId: number) =>
      api()
        .post("/ownership/modules/crm/transfer")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ toMembershipId, expiresInHours: 48 });

    const first = await initiate(heirMembershipId);
    expect(first.status).toBe(201);

    const second = await initiate(spareMembershipId);
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      'A pending transfer for module "crm" already exists',
    );
  });

  /**
   * The same index reached through the module-access screen, which is a
   * separate service with its own copy of the dead handler.
   */
  it("refuses a second pending transfer initiated from the module-access screen", async () => {
    await clearTransfers();

    const initiate = (toUserId: string) =>
      api()
        .post("/module-access/crm/ownership/transfer")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", randomUUID())
        .send({ toUserId });

    const first = await initiate(heirUserId);
    expect(first.status).toBe(201);

    const second = await initiate(fixture.members["spare"]!.userId);
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      'A pending transfer for module "crm" already exists',
    );
  });

  /**
   * The two group-name handlers guard `uniq_roles_org_module_name_ci` —
   * (org_id, COALESCE(module_key, ''), LOWER(name)) — behind a read-then-write
   * name check. A sequential duplicate is answered by that check, so the only
   * way to the index is two requests passing the check together.
   *
   * What is asserted is therefore the invariant, not which request lost: one
   * group is created, the other is refused with a 409, and neither is a 500.
   * Before the fix the loser propagated a DrizzleQueryError and answered 500,
   * so this case does distinguish fixed from broken — but it reaches the index
   * only when the interleaving cooperates, and on the runs where the check
   * answers first it passes for the weaker reason. A deterministic proof would
   * need a controlled interleaving this harness cannot express; that is a
   * limitation of the test, not a claim about the code.
   */
  it("never answers 500 when two requests create the same group name at once", async () => {
    const name = `Race ${randomUUID().slice(0, 8)}`;
    const create = () =>
      api()
        .post("/module-access/crm/groups")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name });

    const [a, b] = await Promise.all([create(), create()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);

    expect(statuses).toEqual([201, 409]);
  });

  it("never answers 500 when two requests rename groups onto one name at once", async () => {
    const target = `Target ${randomUUID().slice(0, 8)}`;
    const make = async (name: string) => {
      const created = await api()
        .post("/module-access/crm/groups")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name });
      expect(created.status).toBe(201);
      return created.body.id as number;
    };

    const first = await make(`${target} one`);
    const second = await make(`${target} two`);

    const rename = (groupId: number) =>
      api()
        .patch(`/module-access/crm/groups/${groupId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: target });

    const [a, b] = await Promise.all([rename(first), rename(second)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);

    expect(statuses).toEqual([200, 409]);
  });
});
