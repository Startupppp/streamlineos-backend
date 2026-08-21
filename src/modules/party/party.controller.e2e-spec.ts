import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Party auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const PARTY_ID = "00000000-0000-0000-0000-000000000010";
  const CONTACT_ID = "00000000-0000-0000-0000-000000000011";

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/party/parties"],
    ["post", "/party/parties"],
    ["get", `/party/parties/${PARTY_ID}`],
    ["patch", `/party/parties/${PARTY_ID}`],
    ["delete", `/party/parties/${PARTY_ID}`],
    ["get", `/party/parties/${PARTY_ID}/contacts`],
    ["post", `/party/parties/${PARTY_ID}/contacts`],
    ["patch", `/party/contacts/${CONTACT_ID}`],
    ["delete", `/party/contacts/${CONTACT_ID}`],
  ];

  it.each(protectedRoutes)(
    "401 on %s %s without a token",
    async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
    },
  );

  it("403 on POST /party/parties without party:parties:create permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/party/parties")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Acme Corp", type: "COMPANY" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /party/parties/:partyId without party:parties:update permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch(`/party/parties/${PARTY_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Corp" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /party/parties/:partyId without party:parties:delete permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete(`/party/parties/${PARTY_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /party/parties/:partyId/contacts without party:contacts:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post(`/party/parties/${PARTY_ID}/contacts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Jane Doe", email: "jane@example.com" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /party/parties without party:parties:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/party/parties")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
