import request from "supertest";
import { eq } from "drizzle-orm";
import { orgModules, signEnvelopes, signOrgSettings } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * SIGN-P0-03, SIGN-P0-04 and SIGN-P1-03. The authentication menu was mostly a
 * menu.
 *
 * The DTO enum accepted eight methods. `authenticate` implements three, and
 * answers "not yet supported" for the other five. Worse, choosing `otp_sms`
 * *required* a phone number — a mandatory field collected for a channel that
 * could never send, on an envelope that would then refuse to be signed.
 *
 * Meanwhile `sign_org_settings.allowed_auth_methods` had been writable since
 * SignOS shipped and read by nothing, and its default is exactly the three
 * methods that work. The organisation's own configuration already said "do not
 * offer SMS"; nothing honoured it.
 *
 * So the fix is not a new switch. It is reading the one that was already
 * there, and refusing at configuration time — in front of the person setting
 * the envelope up, who can still change it — rather than at signing time, in
 * front of a customer holding a link.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=sign-auth-method-honesty
 */

describe(`${SEEDED_HARNESS} sign authentication methods are offered honestly`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";
  let envelopeId = 0;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("sender", {
        permissionKeys: ["sign:envelope:create", "sign:envelope:view", "sign:admin:manage"],
      })
      .build();
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "sign", enabled: true })
      .onConflictDoNothing();

    token = await signSeededToken(fixture.members["sender"]!.userId, fixture.orgId);

    const created = await request(seeded.app.getHttpServer())
      .post("/sign/envelopes")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Auth method probe" });
    expect(created.status).toBe(201);
    envelopeId = created.body.id ?? created.body.envelope?.id;
    expect(envelopeId).toBeGreaterThan(0);
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb.delete(signEnvelopes).where(eq(signEnvelopes.orgId, fixture.orgId));
      await seeded.seedDb.delete(signOrgSettings).where(eq(signOrgSettings.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 60_000);

  const addRecipient = (body: object) =>
    request(seeded.app.getHttpServer())
      .post(`/sign/envelopes/${envelopeId}/recipients`)
      .set("Authorization", `Bearer ${token}`)
      .send({ roleName: "Signer", name: "Probe Person", email: "probe@example.invalid", ...body });

  it("accepts the methods that actually work", async () => {
    const res = await addRecipient({ roleName: "Email link", authMethod: "email_link" });
    expect(res.status).toBe(201);

    const otp = await addRecipient({ roleName: "Email OTP", authMethod: "otp_email" });
    expect(otp.status).toBe(201);
  }, 60_000);

  /**
   * The broken promise, gone. Before this, the request was accepted and a
   * phone number demanded; the envelope then could not be signed at all.
   */
  it("refuses SMS OTP, and does not ask for a phone number it cannot use", async () => {
    const res = await addRecipient({ roleName: "SMS OTP", authMethod: "otp_sms" });

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toMatch(/not enabled for this organisation/i);
    /** Crucially NOT "Phone number is required" — that was the broken promise. */
    expect(message).not.toMatch(/phone number is required/i);
  }, 60_000);

  it("refuses every method the signing flow cannot honour", async () => {
    for (const method of ["sso", "passkey", "kba", "id_verification"]) {
      const res = await addRecipient({ roleName: `Method ${method}`, authMethod: method });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not enabled for this organisation/i);
    }
  }, 120_000);

  /**
   * And it is the organisation's list being read, not a hardcoded one. An org
   * that enables SMS gets a different, more specific refusal — the environment
   * has no provider — instead of the same blanket answer.
   */
  it("gives a different answer once the organisation enables SMS", async () => {
    await seeded.seedDb
      .update(signOrgSettings)
      .set({ allowedAuthMethods: ["email_link", "access_code", "otp_email", "otp_sms"] })
      .where(eq(signOrgSettings.orgId, fixture.orgId));

    const res = await addRecipient({ roleName: "SMS enabled", authMethod: "otp_sms", phone: "+15550100" });

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toMatch(/no SMS provider is configured/i);
    expect(message).not.toMatch(/not enabled for this organisation/i);
  }, 60_000);
});
