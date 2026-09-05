import request from "supertest";
import {
  computeTokenCharge,
  MIN_CHARGE_MILLI,
} from "src/modules/ai/core/billing/ai-model-pricing.constants";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

describe("[seeded-e2e] Billing enforcement — seat limit, billing non-delegable, AI token metering", () => {
  let seeded: SeededE2eApp;
  let freeOrg: SeededFixture;
  let delegOrg: SeededFixture;
  let freeOwnerToken = "";
  let delegOwnerToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    freeOrg = await seedOrg(seeded.seedDb)
      .addMember("owner", { standing: "OWNER" })
      .addMember("m1", {})
      .addMember("m2", {})
      .addMember("m3", {})
      .addMember("m4", {})
      .build();

    delegOrg = await seedOrg(seeded.seedDb)
      .addMember("owner", { standing: "OWNER" })
      .addMember("delegatee", {})
      .build();

    freeOwnerToken = await signSeededToken(
      seeded,
      freeOrg.members.owner?.userId ?? "",
      freeOrg.orgId,
    );
    delegOwnerToken = await signSeededToken(
      seeded,
      delegOrg.members.owner?.userId ?? "",
      delegOrg.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (freeOrg) await freeOrg.teardown();
    if (delegOrg) await delegOrg.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — free org has owner + 4 members and delegation org has owner + delegatee", () => {
    expect(Object.keys(freeOrg.members)).toHaveLength(5);
    expect(freeOrg.members.owner?.userId).toBeTruthy();
    expect(delegOrg.members.owner?.userId).toBeTruthy();
    expect(delegOrg.members.delegatee?.userId).toBeTruthy();
    expect(freeOrg.orgId).not.toBe(delegOrg.orgId);
  });

  it("SEAT LIMIT — a FREE-plan org at 5 seats gets 402 when the owner tries to invite a sixth member", async () => {
    const response = await request(server as never)
      .post("/users/invite")
      .set("Authorization", `Bearer ${freeOwnerToken}`)
      .send({ email: "sixth-member@test.invalid" });

    expect(response.status).toBe(402);
  });

  it("BILLING NON-DELEGABLE — delegating a billing permission key is refused at 403 regardless of the delegator's standing", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const response = await request(server as never)
      .post("/access/delegations")
      .set("Authorization", `Bearer ${delegOwnerToken}`)
      .send({
        delegateeId: delegOrg.members.delegatee?.userId ?? "",
        permissions: ["billing:plans:view"],
        endsAt: futureDate,
      });

    expect(response.status).toBe(403);
  });

  it("AI BILLING TOKEN-METERED — computeTokenCharge produces proportional integer milli-credits, not a flat per-action constant", () => {
    const small = computeTokenCharge("gpt-4o-mini", 100, 50);
    const large = computeTokenCharge("gpt-4o-mini", 10_000, 5_000);

    expect(Number.isInteger(small.milliCredits)).toBe(true);
    expect(Number.isInteger(large.milliCredits)).toBe(true);
    expect(small.milliCredits).toBeGreaterThanOrEqual(MIN_CHARGE_MILLI);
    expect(large.milliCredits).toBeGreaterThan(small.milliCredits);
    expect(small.milliCredits).not.toBe(large.milliCredits);
  });
});
