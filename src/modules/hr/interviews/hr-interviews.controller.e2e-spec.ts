import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("HR Interviews auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "put" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/recruitment/interviews/slas"],
    ["put", "/hr/recruitment/interviews/slas"],
    ["get", "/hr/recruitment/interviews/sla-report"],
    ["get", "/hr/recruitment/interviews/1/scorecard/summary"],
    ["get", "/hr/recruitment/interviews/1/ics"],
    ["get", "/hr/recruitment/interviewers/availability"],
    ["get", "/hr/recruitment/interviewer-performance"],
    ["get", "/hr/recruitment/booking-links"],
    ["patch", "/hr/recruitment/booking-links/1"],
    ["get", "/hr/recruitment/hiring-flows"],
    ["post", "/hr/recruitment/hiring-flows"],
    ["get", "/hr/recruitment/hiring-flows/1"],
    ["patch", "/hr/recruitment/hiring-flows/1"],
    ["delete", "/hr/recruitment/hiring-flows/1"],
    ["get", "/hr/recruitment/hiring-flows/1/rounds"],
    ["post", "/hr/recruitment/hiring-flows/1/rounds"],
    ["patch", "/hr/recruitment/hiring-flows/1/rounds/1"],
    ["delete", "/hr/recruitment/hiring-flows/1/rounds/1"],
    ["get", "/hr/recruitment/offer-templates"],
    ["post", "/hr/recruitment/offer-templates"],
    ["patch", "/hr/recruitment/offer-templates/1"],
    ["delete", "/hr/recruitment/offer-templates/1"],
    ["post", "/hr/recruitment/offer-templates/1/generate-pdf"],
    ["post", "/hr/recruitment/offer-letter"],
    ["get", "/hr/recruitment/scorecard-templates"],
    ["post", "/hr/recruitment/scorecard-templates"],
    ["patch", "/hr/recruitment/scorecard-templates/1"],
    ["delete", "/hr/recruitment/scorecard-templates/1"],
    ["get", "/hr/recruitment/scorecard-analytics"],
    ["post", "/hr/recruitment/reports/generate"],
    ["get", "/hr/recruitment/reports/scheduled"],
    ["post", "/hr/recruitment/reports/scheduled"],
    ["delete", "/hr/recruitment/reports/scheduled/1"],
    ["get", "/hr/recruitment/analytics"],
    ["get", "/hr/recruitment/stats"],
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
      case "put":
        return agent.put(path);
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
