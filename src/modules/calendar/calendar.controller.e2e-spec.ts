import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Calendar auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "put" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "put":
        return agent.put(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/calendar/events"],
    ["post", "/calendar/events"],
    ["put", "/calendar/events/1"],
    ["delete", "/calendar/events/1"],
    ["post", "/calendar/events/1/rsvp"],
    ["get", "/calendar/events/1/rsvp"],
    ["get", "/calendar/export"],
  ];

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
