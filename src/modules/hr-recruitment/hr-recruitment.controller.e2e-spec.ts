import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("HR Recruitment auth (e2e)", () => {
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

  type Method = "get" | "post" | "patch" | "put" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/recruitment/candidates"],
    ["post", "/hr/recruitment/candidates"],
    ["get", "/hr/recruitment/candidates/1"],
    ["patch", "/hr/recruitment/candidates/1"],
    ["delete", "/hr/recruitment/candidates/1"],
    ["patch", "/hr/recruitment/candidates/1/stage"],
    ["post", "/hr/recruitment/candidates/bulk-import"],
    ["post", "/hr/recruitment/candidates/import"],
    ["post", "/hr/recruitment/candidates/bulk-reject"],
    ["get", "/hr/recruitment/candidates/1/sla"],
    ["patch", "/hr/recruitment/candidates/1/sla"],
    ["post", "/hr/recruitment/candidates/1/applications"],
    ["patch", "/hr/recruitment/candidates/1/bgv-status"],
    ["get", "/hr/recruitment/candidates/1/calibration"],
    ["post", "/hr/recruitment/candidates/1/calibration"],
    ["get", "/hr/recruitment/candidates/1/referral"],
    ["get", "/hr/recruitment/candidates/1/reference-checks"],
    ["patch", "/hr/recruitment/candidates/1/reference-checks/1"],
    ["get", "/hr/recruitment/candidates/1/documents"],
    ["get", "/hr/recruitment/candidates/1/documents/1/view"],
    ["get", "/hr/recruitment/candidates/1/vault"],
    ["get", "/hr/recruitment/candidates/1/vault/access-logs"],
    ["get", "/hr/recruitment/candidates/1/offers"],
    ["post", "/hr/recruitment/candidates/1/offers/1/submit-for-approval"],
    ["post", "/hr/recruitment/candidates/1/offers/1/approve"],
    ["patch", "/hr/recruitment/candidates/1/offers/1"],
    ["delete", "/hr/recruitment/candidates/1/offers/1"],
    ["get", "/hr/recruitment/pipeline"],
    ["get", "/hr/recruitment/diversity-report"],
    ["get", "/hr/recruitment/bgv-compliance"],
    ["get", "/hr/recruitment/jobs"],
    ["post", "/hr/recruitment/jobs"],
    ["get", "/hr/recruitment/jobs/1"],
    ["patch", "/hr/recruitment/jobs/1"],
    ["delete", "/hr/recruitment/jobs/1"],
    ["post", "/hr/recruitment/jobs/1/publish"],
    ["post", "/hr/recruitment/jobs/1/duplicate"],
    ["get", "/hr/recruitment/jobs/1/recruiters"],
    ["post", "/hr/recruitment/jobs/1/recruiters"],
    ["get", "/hr/recruitment/jobs/1/share"],
    ["get", "/hr/recruitment/internal-jobs"],
    ["post", "/hr/recruitment/internal-jobs/1/apply"],
    ["get", "/hr/recruitment/portals"],
    ["post", "/hr/recruitment/portals"],
    ["post", "/hr/recruitment/portals/linkedin/sync"],
    ["get", "/hr/recruitment/recruiters"],
    ["get", "/hr/recruitment/recruiters/activity"],
    ["post", "/hr/recruitment/recruiters/activity"],
    ["get", "/hr/recruitment/referrals"],
    ["post", "/hr/recruitment/referrals"],
    ["patch", "/hr/recruitment/referrals/1"],
    ["get", "/hr/recruitment/vendors"],
    ["post", "/hr/recruitment/vendors"],
    ["patch", "/hr/recruitment/vendors/1"],
    ["delete", "/hr/recruitment/vendors/1"],
    ["get", "/hr/recruitment/vendors/1/submissions"],
    ["post", "/hr/recruitment/vendors/1/submissions"],
    ["get", "/hr/recruitment/headcount"],
    ["post", "/hr/recruitment/headcount"],
    ["patch", "/hr/recruitment/headcount/1"],
    ["delete", "/hr/recruitment/headcount/1"],
    ["post", "/hr/recruitment/headcount/1/approve"],
    ["post", "/hr/recruitment/headcount/1/reject"],
    ["post", "/hr/recruitment/headcount/1/create-job"],
    ["get", "/hr/recruitment/automations"],
    ["post", "/hr/recruitment/automations"],
    ["patch", "/hr/recruitment/automations/1"],
    ["delete", "/hr/recruitment/automations/1"],
    ["get", "/hr/recruitment/messages/threads"],
    ["patch", "/hr/recruitment/messages/1"],
    ["get", "/hr/recruitment/email-sequences"],
    ["post", "/hr/recruitment/email-sequences"],
    ["get", "/hr/recruitment/email-sequences/1"],
    ["patch", "/hr/recruitment/email-sequences/1"],
    ["delete", "/hr/recruitment/email-sequences/1"],
    ["post", "/hr/recruitment/email-sequences/1/enroll"],
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
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
