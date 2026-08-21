import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("HR Time auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/leaves/balance"],
    ["get", "/hr/leaves/my"],
    ["get", "/hr/leaves/team"],
    ["get", "/hr/leaves/this-week"],
    ["get", "/hr/leaves/analytics"],
    ["post", "/hr/leaves/comp-off"],
    ["patch", "/hr/leaves/1"],
    ["get", "/hr/leave-calendar"],
    ["post", "/hr/attendance/check-in"],
    ["post", "/hr/attendance/check-out"],
    ["post", "/hr/attendance/break"],
    ["get", "/hr/attendance/status"],
    ["get", "/hr/attendance/logs"],
    ["get", "/hr/attendance/monthly"],
    ["get", "/hr/attendance/heatmap"],
    ["get", "/hr/attendance/team-status"],
    ["get", "/hr/wfh"],
    ["post", "/hr/wfh"],
    ["get", "/hr/wfh/pending"],
    ["patch", "/hr/wfh/1"],
    ["get", "/hr/work-logs"],
    ["post", "/hr/work-logs"],
    ["get", "/hr/work-logs/export"],
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
});
