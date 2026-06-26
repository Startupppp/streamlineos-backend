import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Chat auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete" | "put";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/chat/channels"],
    ["post", "/chat/channels"],
    ["get", "/chat/channels/1"],
    ["patch", "/chat/channels/1"],
    ["get", "/chat/channels/1/members"],
    ["post", "/chat/channels/1/read"],
    ["post", "/chat/channels/1/typing"],
    ["get", "/chat/channels/1/typing"],
    ["get", "/chat/channels/1/messages"],
    ["post", "/chat/channels/1/messages"],
    ["get", "/chat/channels/1/messages/poll"],
    ["patch", "/chat/channels/1/messages/1"],
    ["delete", "/chat/channels/1/messages/1"],
    ["post", "/chat/channels/1/messages/1/reactions"],
    ["post", "/chat/presence/heartbeat"],
    ["get", "/chat/presence/online"],
    ["put", "/chat/status"],
    ["get", "/chat/unread"],
    ["get", "/chat/search"],
    ["get", "/chat/users"],
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
      case "put":
        return agent.put(path);
    }
  }

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
