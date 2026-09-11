import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("Chat auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete" | "put";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/chat/channels"],
    ["post", "/chat/channels"],
    ["get", "/chat/channels/archived"],
    ["get", "/chat/channels/public"],
    ["get", "/chat/channels/1"],
    ["patch", "/chat/channels/1"],
    ["get", "/chat/channels/1/members"],
    ["post", "/chat/channels/1/members"],
    ["delete", "/chat/channels/1/members/user-1"],
    ["patch", "/chat/channels/1/members/user-1/role"],
    ["post", "/chat/channels/1/join"],
    ["post", "/chat/channels/1/leave"],
    ["post", "/chat/channels/1/archive"],
    ["post", "/chat/channels/1/unarchive"],
    ["post", "/chat/channels/1/mute"],
    ["post", "/chat/channels/1/unmute"],
    ["post", "/chat/channels/1/favorite"],
    ["post", "/chat/channels/1/unfavorite"],
    ["post", "/chat/channels/1/notification-preference"],
    ["post", "/chat/channels/1/mark-unread"],
    ["get", "/chat/channels/1/files"],
    ["get", "/chat/channels/1/attachments/1"],
    ["post", "/chat/channels/1/read"],
    ["post", "/chat/channels/1/typing"],
    ["get", "/chat/channels/1/typing"],
    ["get", "/chat/channels/1/messages"],
    ["post", "/chat/channels/1/messages"],
    ["get", "/chat/channels/1/messages/poll"],
    ["patch", "/chat/channels/1/messages/1"],
    ["delete", "/chat/channels/1/messages/1"],
    ["post", "/chat/channels/1/messages/1/reactions"],
    ["delete", "/chat/channels/1/messages/1/reactions/x"],
    ["get", "/chat/channels/1/messages/1/thread"],
    ["post", "/chat/channels/1/messages/1/thread"],
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
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
