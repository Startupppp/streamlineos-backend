import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Csat auth (e2e)", () => {
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
    ["get", "/csat"],
    ["post", "/csat"],
    ["get", "/csat/1"],
    ["patch", "/csat/1"],
    ["delete", "/csat/1"],
    ["get", "/csat/1/responses"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("does NOT require auth on POST /csat/public/:publicToken/responses (public endpoint)", async () => {
    const res = await callRoute(
      "post",
      "/csat/public/00000000-0000-4000-8000-000000000000/responses",
    ).send({ rating: 5 });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
