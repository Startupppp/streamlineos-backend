import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";

describe("Branches auth/RBAC (e2e)", () => {
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

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/branches"],
    ["get", "/branches/00000000-0000-4000-8000-000000000001"],
    ["patch", "/branches/00000000-0000-4000-8000-000000000001"],
    ["delete", "/branches/00000000-0000-4000-8000-000000000001"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  const permGatedGetRoutes: ReadonlyArray<string> = ["/branches", "/branches/00000000-0000-4000-8000-000000000001"];

  it.each(permGatedGetRoutes)(
    "403 on GET %s without branch:view permission",
    async (path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await callRoute("get", path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    },
  );
});
