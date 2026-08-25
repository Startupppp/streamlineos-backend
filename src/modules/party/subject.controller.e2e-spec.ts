import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

describe("Subject auth/RBAC (e2e)", () => {
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

  const TYPE_ID = "00000000-0000-0000-0000-000000000020";
  const SUBJECT_ID = "00000000-0000-0000-0000-000000000021";
  const LINK_ID = "00000000-0000-0000-0000-000000000022";
  const PARTY_ID = "00000000-0000-0000-0000-000000000010";

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/party/subject-types"],
    ["post", "/party/subject-types"],
    ["patch", `/party/subject-types/${TYPE_ID}`],
    ["delete", `/party/subject-types/${TYPE_ID}`],
    ["get", "/party/subjects"],
    ["get", `/party/subjects/${SUBJECT_ID}`],
    ["post", "/party/subjects"],
    ["patch", `/party/subjects/${SUBJECT_ID}`],
    ["delete", `/party/subjects/${SUBJECT_ID}`],
    ["post", `/party/subjects/${SUBJECT_ID}/parties`],
    ["delete", `/party/subject-links/${LINK_ID}`],
    ["get", `/party/parties/${PARTY_ID}/subjects`],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const permissionCases: ReadonlyArray<[Method, string, string]> = [
    ["get", "/party/subject-types", "party:subjects:view"],
    ["get", "/party/subjects", "party:subjects:view"],
    ["get", `/party/subjects/${SUBJECT_ID}`, "party:subjects:view"],
    ["get", `/party/parties/${PARTY_ID}/subjects`, "party:subjects:view"],
    ["post", "/party/subjects", "party:subjects:manage"],
    ["patch", `/party/subjects/${SUBJECT_ID}`, "party:subjects:manage"],
    ["delete", `/party/subjects/${SUBJECT_ID}`, "party:subjects:manage"],
    ["post", `/party/subjects/${SUBJECT_ID}/parties`, "party:subjects:manage"],
    ["delete", `/party/subject-links/${LINK_ID}`, "party:subjects:manage"],
    ["post", "/party/subject-types", "party:subject-types:manage"],
    ["patch", `/party/subject-types/${TYPE_ID}`, "party:subject-types:manage"],
    ["delete", `/party/subject-types/${TYPE_ID}`, "party:subject-types:manage"],
  ];

  it.each(permissionCases)(
    "403 on %s %s without %s",
    async (method, path, _permission) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    },
  );

  /**
   * Declaring a type is a different act from editing a record of it: a
   * declaration change reshapes every existing record. Holding the record keys
   * must not carry the declaration key with it.
   */
  it.each([
    ["post", "/party/subject-types"] as const,
    ["patch", `/party/subject-types/${TYPE_ID}`] as const,
    ["delete", `/party/subject-types/${TYPE_ID}`] as const,
  ])("403 on %s %s for a holder of the record keys alone", async (method, path) => {
    const token = await signToken({
      permissions: ["party:subjects:view", "party:subjects:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await callRoute(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /party/subjects for a holder of the declaration key alone", async () => {
    const token = await signToken({
      permissions: ["party:subject-types:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/party/subjects")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
