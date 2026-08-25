import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Inbound ingress auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const VALID = {
    organizationId: "00000000-0000-0000-0000-000000000001",
    channel: "email",
    provider: "fixture",
    providerMessageId: "msg-1",
    occurredAt: "2026-08-23T10:00:00.000Z",
    subject: "Quote for Q3",
    participants: [{ address: "priya@example.com", role: "from" }],
  };

  it("401 on POST /crm/ingress/inbound without a token", async () => {
    const res = await request(app.getHttpServer()).post("/crm/ingress/inbound").send(VALID);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  /**
   * An open ingress writes parties and activities into any tenant that can be
   * named, so it is gated like every other write.
   */
  it("403 without crm:ingress:submit", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/crm/ingress/inbound")
      .set("Authorization", `Bearer ${token}`)
      .send(VALID);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 for a holder of the activity keys alone", async () => {
    const token = await signToken({
      permissions: ["crm:activities:view", "crm:activities:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/crm/ingress/inbound")
      .set("Authorization", `Bearer ${token}`)
      .send(VALID);
    expect(res.status).toBe(403);
  });

  const malformed: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["an unknown channel", { ...VALID, channel: "carrier-pigeon" }],
    ["no provider message id", { ...VALID, providerMessageId: "" }],
    ["nobody on it", { ...VALID, participants: [] }],
    ["an unparseable timestamp", { ...VALID, occurredAt: "yesterday" }],
    ["a provider-shaped extra field", { ...VALID, gmailThreadId: "leaked" }],
  ];

  it.each(malformed)("400 on %s", async (_case, body) => {
    const token = await signToken({
      permissions: ["crm:ingress:submit"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/crm/ingress/inbound")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(400);
  });
});
