import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";

describe("Deals auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

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

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/deals"],
    ["post", "/deals"],
    ["patch", "/deals/bulk"],
    ["delete", "/deals/bulk"],
    ["get", "/deals/stats"],
    ["get", "/deals/aging"],
    ["get", "/deals/forecast"],
    ["get", "/deals/win-loss"],
    ["get", "/deals/approval-rules"],
    ["post", "/deals/approval-rules"],
    ["get", "/deals/approvals"],
    ["post", "/deals/approvals"],
    ["post", "/deals/1/clone"],
    ["get", "/deals/1/activities"],
    ["post", "/deals/1/activities"],
    ["get", "/deals/1/transitions"],
    ["patch", "/deals/1/custom-data"],
    ["get", "/deals/1/meetings"],
    ["post", "/deals/1/meetings"],
    ["patch", "/deals/1/meetings/1"],
    ["delete", "/deals/1/meetings/1"],
    ["get", "/deals/1"],
    ["patch", "/deals/1"],
    ["delete", "/deals/1"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /deals without crm:deals read", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer()).get("/deals").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /deals without crm:deals create", async () => {
    const token = await signToken({ permissions: ["crm:deals:read"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer()).post("/deals").set("Authorization", `Bearer ${token}`).send({ name: "x" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /deals/1 without crm:deals delete", async () => {
    const token = await signToken({ permissions: ["crm:deals:read"], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer()).delete("/deals/1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /deals/approvals resolve for a non-owner holding the write permission", async () => {
    const token = await signToken({
      permissions: ["crm:deals:update"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/deals/approvals")
      .set("Authorization", `Bearer ${token}`)
      .send({ approvalId: 1, action: "approve" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Only admins can resolve approvals" });
  });

  const readGatedGetRoutes: ReadonlyArray<string> = [
    "/deals/stats",
    "/deals/aging",
    "/deals/forecast",
    "/deals/win-loss",
    "/deals/approval-rules",
    "/deals/approvals",
    // The stage ledger is the accountability record, so it is read-gated like
    // the deal itself rather than left open.
    "/deals/1/transitions",
  ];

  it.each(readGatedGetRoutes)(
    "403 on GET %s without crm:deals:read",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  it.each(readGatedGetRoutes)(
    "passes the ability gate on GET %s with crm:deals:read",
    async (path) => {
      const token = await signToken({
        permissions: ["crm:deals:read"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
