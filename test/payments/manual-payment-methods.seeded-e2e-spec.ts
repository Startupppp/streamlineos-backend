import { and, eq } from "drizzle-orm";
import request from "supertest";
import type { Server } from "node:http";
import { paymentManualMethods } from "src/db/schema";
import { PaymentAuditService } from "src/modules/billing/payments/payment-audit.service";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

describe("[seeded-e2e] manual payment method persistence and isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let server: Server;
  let ownerToken: string;
  let readerToken: string;
  let neighbourMethodId: number;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer<Server>();
    home = await seedOrg(seeded.seedDb).onPlan("PAID")
      .addMember("owner", { standing: "OWNER" })
      .addMember("reader", { permissionKeys: ["payments:providers:view"] }).build();
    neighbour = await seedOrg(seeded.seedDb).onPlan("PAID")
      .addMember("owner", { standing: "OWNER" }).build();
    const owner = home.members.owner;
    const reader = home.members.reader;
    if (!owner || !reader) throw new Error("Payment fixture members missing");
    ownerToken = await signSeededToken(seeded, owner.userId, home.orgId);
    readerToken = await signSeededToken(seeded, reader.userId, home.orgId);
    const [method] = await seeded.seedDb.insert(paymentManualMethods).values({
      orgId: neighbour.orgId, methodType: "cash", displayName: "Neighbour cash", status: "disabled",
    }).returning({ id: paymentManualMethods.id });
    if (!method) throw new Error("Payment fixture insert failed");
    neighbourMethodId = method.id;
  }, 180_000);

  afterAll(async () => {
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function savedMethod(orgId: string, methodType: string) {
    return seeded.seedDb.query.paymentManualMethods.findFirst({
      where: and(eq(paymentManualMethods.orgId, orgId), eq(paymentManualMethods.methodType, methodType)),
      columns: { id: true, displayName: true, instructions: true, status: true },
    });
  }

  it("persists an allowed mutation and returns only the caller's methods", async () => {
    await request(server).post("/payments/manual-methods")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ methodType: "cash", displayName: "Home cash", instructions: "Pay at reception" }).expect(201);
    expect(await savedMethod(home.orgId, "cash")).toMatchObject({ displayName: "Home cash", status: "enabled" });
    const result = await request(server).get("/payments/manual-methods")
      .set("Authorization", `Bearer ${ownerToken}`).expect(200);
    expect(result.body).toEqual(expect.arrayContaining([expect.objectContaining({ orgId: home.orgId, displayName: "Home cash" })]));
    expect(result.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ orgId: neighbour.orgId })]));
  });

  it("denies read-only mutation and leaves no new method", async () => {
    await request(server).post("/payments/manual-methods")
      .set("Authorization", `Bearer ${readerToken}`)
      .send({ methodType: "cheque", displayName: "Forbidden" }).expect(403);
    expect(await savedMethod(home.orgId, "cheque")).toBeUndefined();
  });

  it("denies unauthenticated access and protected body fields", async () => {
    await request(server).get("/payments/manual-methods").expect(401);
    await request(server).post("/payments/manual-methods")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ methodType: "cheque", displayName: "Forbidden", orgId: neighbour.orgId }).expect(400);
    expect(await savedMethod(home.orgId, "cheque")).toBeUndefined();
  });

  it("rejects cross-tenant update and disable without modifying the foreign record", async () => {
    await request(server).patch(`/payments/manual-methods/${neighbourMethodId}`)
      .set("Authorization", `Bearer ${ownerToken}`).send({ displayName: "Stolen" }).expect(404);
    await request(server).post(`/payments/manual-methods/${neighbourMethodId}/disable`)
      .set("Authorization", `Bearer ${ownerToken}`).expect(404);
    expect(await savedMethod(neighbour.orgId, "cash")).toMatchObject({ displayName: "Neighbour cash", status: "disabled" });
  });

  it("serializes concurrent create-or-update for one organization and method type", async () => {
    const responses = await Promise.all(Array.from({ length: 3 }, () => request(server)
      .post("/payments/manual-methods").set("Authorization", `Bearer ${ownerToken}`)
      .send({ methodType: "upi", displayName: "UPI", upiId: "fixture@upi" })));
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const rows = await seeded.seedDb.select({ id: paymentManualMethods.id }).from(paymentManualMethods)
      .where(and(eq(paymentManualMethods.orgId, home.orgId), eq(paymentManualMethods.methodType, "upi")));
    expect(rows).toHaveLength(1);
  });

  it("rolls back a payment configuration write when its audit cannot persist", async () => {
    const audit = jest.spyOn(seeded.app.get(PaymentAuditService), "log")
      .mockRejectedValueOnce(new Error("Injected audit failure"));
    try {
      await request(server).post("/payments/manual-methods")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ methodType: "other", displayName: "Must roll back" }).expect(500);
      expect(await savedMethod(home.orgId, "other")).toBeUndefined();
    } finally {
      audit.mockRestore();
    }
  });
});
