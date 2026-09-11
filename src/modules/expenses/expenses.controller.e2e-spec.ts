import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";

describe("Expenses auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/expenses"],
    ["get", "/hr/expenses/page-data"],
    ["get", "/hr/expenses/report"],
    ["get", "/hr/expenses/export/jobs/job-1"],
    ["get", "/hr/expenses/export/jobs/job-1/download"],
    ["post", "/hr/expenses/export/jobs"],
    ["post", "/hr/expenses/email-report"],
    ["post", "/hr/expenses"],
    ["patch", "/hr/expenses/1"],
    ["post", "/hr/expenses/1/submit"],
    ["post", "/hr/expenses/1/approve"],
    ["post", "/hr/expenses/1/reject"],
    ["delete", "/hr/expenses/1"],
    ["get", "/hr/expenses/categories"],
    ["post", "/hr/expenses/categories"],
  ];

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

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on POST /hr/expenses/categories without hr:expenses manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/hr/expenses/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Travel" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
