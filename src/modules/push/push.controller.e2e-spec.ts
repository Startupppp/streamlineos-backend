import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Push auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["post", "/push/subscribe"],
    ["delete", "/push/subscribe"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("does NOT require auth on GET /push/vapid-public-key (public endpoint)", async () => {
    const res = await callRoute("get", "/push/vapid-public-key");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
