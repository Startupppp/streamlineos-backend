import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";

describe("ProjectsPortfolios/Programs auth/RBAC (e2e)", () => {
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

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/portfolios"],
    ["get", "/build/portfolios/1"],
    ["post", "/build/portfolios"],
    ["patch", "/build/portfolios/1"],
    ["delete", "/build/portfolios/1"],
    ["post", "/build/portfolios/1/projects"],
    ["delete", "/build/portfolios/1/projects/2"],
    ["get", "/build/programs"],
    ["get", "/build/programs/1"],
    ["post", "/build/programs"],
    ["patch", "/build/programs/1"],
    ["delete", "/build/programs/1"],
    ["post", "/build/programs/1/projects"],
    ["delete", "/build/programs/1/projects/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/portfolios without projects:portfolios:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/portfolios")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/portfolios without projects:portfolios:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/portfolios")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Q3 Portfolio" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/portfolios/1/projects without projects:portfolios:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/portfolios/1/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectId: 5 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/programs without projects:programs:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/programs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/programs without projects:programs:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/programs")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Alpha Program" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/programs/1/projects without projects:programs:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/programs/1/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectId: 7 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("does NOT enforce manage gate on GET /projects/portfolios with view ability", async () => {
    const token = await signToken({
      permissions: ["build:portfolios:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/portfolios")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
