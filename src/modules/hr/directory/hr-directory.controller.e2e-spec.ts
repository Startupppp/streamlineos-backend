import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";

describe("HR Directory auth/RBAC (e2e)", () => {
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
      default: {
        const _exhaustive: never = method;
        throw new Error(`Unsupported HTTP method: ${_exhaustive}`);
      }
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/directory"],
    ["get", "/hr/celebrations"],
    ["get", "/hr/org-chart"],
    ["get", "/hr/headcount"],
    ["get", "/hr/teams/1"],
    ["get", "/hr/employees"],
    ["get", "/hr/employees/stats"],
    ["get", "/hr/employees/anniversary-feed"],
    ["get", "/hr/employees/availability"],
    ["get", "/hr/employees/check-email"],
    ["get", "/hr/employees/find-expert"],
    ["get", "/hr/employees/skills-matrix"],
    ["get", "/hr/employees/projects"],
    ["get", "/hr/employees/tickets"],
    ["get", "/hr/employees/u1/reports-to-me"],
    ["get", "/hr/employees/u1/manager-scorecard"],
    ["get", "/hr/employees/u1/profile-pdf"],
    ["get", "/hr/team-events"],
    ["post", "/hr/team-events"],
    ["post", "/hr/team-events/1"],
    ["get", "/hr/asset-returns"],
    ["post", "/hr/asset-returns"],
    ["patch", "/hr/asset-returns/1"],
    ["get", "/hr/devices"],
    ["post", "/hr/devices"],
    ["patch", "/hr/devices/1"],
    ["delete", "/hr/devices/1"],
    ["get", "/hr/background-verification"],
    ["post", "/hr/background-verification"],
    ["patch", "/hr/background-verification"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /hr/employees without hr:employees read", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/hr/employees")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "read", subject: "hr:employees" });
  });

  it("403 on GET /hr/headcount without hr:headcount read", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/hr/headcount")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "read", subject: "hr:headcount" });
  });

  it("403 on POST /hr/asset-returns without hr:assets manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/asset-returns")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "u1", assetName: "Laptop" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "RBAC_DENIED", verb: "manage", subject: "hr:assets" });
  });
});
