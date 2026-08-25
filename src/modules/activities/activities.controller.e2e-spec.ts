import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Activities auth/RBAC (e2e)", () => {
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

  const ACTIVITY_ID = "00000000-0000-0000-0000-000000000030";
  const PARTY_ID = "00000000-0000-0000-0000-000000000010";

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", `/crm/activities/timeline?partyId=${PARTY_ID}`],
    ["get", "/crm/activities/my-tasks"],
    ["post", "/crm/activities"],
    ["get", `/crm/activities/${ACTIVITY_ID}/participants`],
    ["patch", `/crm/activities/${ACTIVITY_ID}`],
    ["post", `/crm/activities/${ACTIVITY_ID}/complete`],
    ["delete", `/crm/activities/${ACTIVITY_ID}`],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const viewGated: ReadonlyArray<[Method, string]> = [
    ["get", `/crm/activities/timeline?partyId=${PARTY_ID}`],
    ["get", "/crm/activities/my-tasks"],
    ["get", `/crm/activities/${ACTIVITY_ID}/participants`],
  ];

  it.each(viewGated)("403 on %s %s without crm:activities:view", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  const manageGated: ReadonlyArray<[Method, string]> = [
    ["post", "/crm/activities"],
    ["patch", `/crm/activities/${ACTIVITY_ID}`],
    ["post", `/crm/activities/${ACTIVITY_ID}/complete`],
    ["delete", `/crm/activities/${ACTIVITY_ID}`],
  ];

  /**
   * Reading a timeline and writing to it are different acts: most of an
   * organisation should see the record without being able to rewrite its history.
   */
  it.each(manageGated)(
    "403 on %s %s for a holder of the read key alone",
    async (method, path) => {
      const token = await signToken({
        permissions: ["crm:activities:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  it("400 on a timeline read with no anchor at all", async () => {
    const token = await signToken({
      permissions: ["crm:activities:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/crm/activities/timeline")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("400 when an activity is created belonging to nothing", async () => {
    const token = await signToken({
      permissions: ["crm:activities:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/crm/activities")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "note", body: "orphaned" });
    expect(res.status).toBe(400);
  });

  it("400 when a due date is put on something that is not a task", async () => {
    const token = await signToken({
      permissions: ["crm:activities:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/crm/activities")
      .set("Authorization", `Bearer ${token}`)
      .send({
        kind: "email",
        partyId: PARTY_ID,
        dueAt: "2026-09-01T00:00:00.000Z",
      });
    expect(res.status).toBe(400);
  });
});
