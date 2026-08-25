import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

/**
 * Who may see the queue, who may hand out its work, and who may change four
 * hundred customer records are three different authorities. These assert the
 * gates rather than the rendering.
 *
 * Payload validation is asserted against the schemas directly in
 * `dto/data-quality.schemas.spec.ts`, for the reason
 * `autonomy-review.controller.e2e-spec.ts` records: the tenant interceptor
 * resolves an organisation's region before a handler runs, so on a database
 * missing a migration every request 500s before validation is reached.
 */
describe("Data quality queue auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => request(app.getHttpServer());
  const bearer = async (permissions: string[]) =>
    `Bearer ${await signToken({ permissions, enabledModules: ALL_MODULES })}`;

  describe("no token at all", () => {
    const routes: ReadonlyArray<[string, "get" | "post", string]> = [
      ["the queue", "get", "/crm/data-quality/findings"],
      ["one finding", "get", "/crm/data-quality/findings/f-1"],
      ["the grouped view", "get", "/crm/data-quality/groups"],
      ["dataset health", "get", "/crm/data-quality/health"],
      ["the decision ledger", "get", "/crm/data-quality/resolutions"],
      ["assignment", "post", "/crm/data-quality/assign"],
      ["a resolution", "post", "/crm/data-quality/resolve"],
      ["a reversal", "post", "/crm/data-quality/resolutions/r-1/reverse"],
      ["a sweep", "post", "/crm/data-quality/scan"],
    ];

    it.each(routes)("401 on %s", async (_label, method, path) => {
      const res = await server()[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  it("403 reading the queue without crm:data-quality:view", async () => {
    const res = await server()
      .get("/crm/data-quality/findings")
      .set("Authorization", await bearer([]));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  /**
   * Reading is not triaging. Someone who may see how bad the data is need not be
   * someone who decides whose weekend it becomes.
   */
  it("403 assigning with the view key alone", async () => {
    const res = await server()
      .post("/crm/data-quality/assign")
      .set("Authorization", await bearer(["crm:data-quality:view"]))
      .send({ selection: { kind: "ids", findingIds: ["f-1"] }, assigneeUserId: "user_2" });
    expect(res.status).toBe(403);
  });

  /**
   * Nor is triaging resolving. Assigning moves a row; resolving merges customer
   * records, four hundred at a time.
   */
  it("403 resolving with the view and assign keys", async () => {
    const res = await server()
      .post("/crm/data-quality/resolve")
      .set("Authorization", await bearer(["crm:data-quality:view", "crm:data-quality:assign"]))
      .send({ selection: { kind: "ids", findingIds: ["f-1"] }, action: "dismiss" });
    expect(res.status).toBe(403);
  });

  it("403 reversing a decision with the view key alone", async () => {
    const res = await server()
      .post("/crm/data-quality/resolutions/r-1/reverse")
      .set("Authorization", await bearer(["crm:data-quality:view"]))
      .send({});
    expect(res.status).toBe(403);
  });

  /**
   * A sweep writes work for the whole organisation and reads a bounded slice of
   * every party, so it sits behind the resolve key rather than the view key.
   */
  it("403 running a sweep with the view key alone", async () => {
    const res = await server()
      .post("/crm/data-quality/scan")
      .set("Authorization", await bearer(["crm:data-quality:view"]))
      .send({});
    expect(res.status).toBe(403);
  });

  it("403 with an unrelated CRM key", async () => {
    const res = await server()
      .get("/crm/data-quality/findings")
      .set("Authorization", await bearer(["crm:deals:read", "crm:autonomy:view"]));
    expect(res.status).toBe(403);
  });

  /**
   * The standing report's key does not carry into the queue's write paths. It
   * predates this module and is granted to CRM members, who must not be able to
   * merge records in bulk.
   */
  it("does not let the report's viewers resolve anything", async () => {
    const res = await server()
      .post("/crm/data-quality/resolve")
      .set("Authorization", await bearer(["crm:data-quality:view"]))
      .send({ selection: { kind: "group", groupKey: "duplicate:email:high" }, action: "apply" });
    expect(res.status).toBe(403);
  });

  it("lets the view key read the queue, the groups and the health number", async () => {
    for (const path of [
      "/crm/data-quality/findings",
      "/crm/data-quality/groups",
      "/crm/data-quality/health",
      "/crm/data-quality/resolutions",
    ]) {
      const res = await server()
        .get(path)
        .set("Authorization", await bearer(["crm:data-quality:view"]));
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    }
  });

  /**
   * Another tenant's finding reads as absent, never as forbidden: a 403 on an
   * identifier that exists elsewhere turns a probe into an existence oracle.
   */
  it("404s a finding that belongs to nobody in this tenant", async () => {
    const res = await server()
      .get("/crm/data-quality/findings/someone-elses-finding")
      .set("Authorization", await bearer(["crm:data-quality:view"]));
    expect([404, 500]).toContain(res.status);
    expect(res.status).not.toBe(403);
  });

  it("402s the whole surface when the CRM module is off", async () => {
    const token = await signToken({
      permissions: ["crm:data-quality:view"],
      enabledModules: ALL_MODULES.filter((module) => module !== "crm"),
    });
    const res = await server()
      .get("/crm/data-quality/findings")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
  });
});
