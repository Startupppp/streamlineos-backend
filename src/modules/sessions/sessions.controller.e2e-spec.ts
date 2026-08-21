import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Sessions auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  const routes: ReadonlyArray<["get" | "delete", string]> = [
    ["get", "/sessions"],
    ["delete", "/sessions"],
    ["delete", "/sessions/some-session-id"],
  ];

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const agent = request(app.getHttpServer());
    const res = await (method === "get" ? agent.get(path) : agent.delete(path));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
