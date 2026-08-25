import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

/**
 * Who may see the three record types, who may raise and work them, and who may
 * raise one over a colleague's head are three different authorities. These
 * assert the gates rather than the rendering.
 *
 * Payload validation is asserted against the schemas directly in
 * `dto/issues.schemas.spec.ts`, for the reason
 * `autonomy-review.controller.e2e-spec.ts` records: the tenant interceptor
 * resolves an organisation's region before a handler runs, so on a database
 * missing a migration every request 500s before validation is reached.
 */
describe("Issues, tasks and complaints auth/RBAC (e2e)", () => {
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
    const routes: ReadonlyArray<[string, "get" | "post" | "patch", string]> = [
      ["the descriptions", "get", "/crm/issues/record-types"],
      ["the list", "get", "/crm/issues?recordType=complaint"],
      ["one record", "get", "/crm/issues/rec_1"],
      ["its history", "get", "/crm/issues/rec_1/transitions"],
      ["raising one", "post", "/crm/issues"],
      ["editing one", "patch", "/crm/issues/rec_1"],
      ["a stage move", "post", "/crm/issues/rec_1/stage"],
      ["an escalation", "post", "/crm/issues/rec_1/escalate"],
    ];

    it.each(routes)("401 on %s", async (_label, method, path) => {
      const res = await server()[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  it("403 reading the list without crm:issues:view", async () => {
    const res = await server()
      .get("/crm/issues?recordType=complaint")
      .set("Authorization", await bearer([]));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 with an unrelated CRM key", async () => {
    const res = await server()
      .get("/crm/issues?recordType=task")
      .set("Authorization", await bearer(["crm:deals:read", "crm:data-quality:view"]));
    expect(res.status).toBe(403);
  });

  /**
   * Seeing how many complaints are open is not the same authority as raising
   * one, and a member holds only the first.
   */
  it("403 raising a record with the view key alone", async () => {
    const res = await server()
      .post("/crm/issues")
      .set("Authorization", await bearer(["crm:issues:view"]))
      .send({ recordType: "task", title: "Chase the renewal", severity: "low" });
    expect(res.status).toBe(403);
  });

  it("403 editing a record with the view key alone", async () => {
    const res = await server()
      .patch("/crm/issues/rec_1")
      .set("Authorization", await bearer(["crm:issues:view"]))
      .send({ severity: "high" });
    expect(res.status).toBe(403);
  });

  /**
   * The one that would have been easiest to get wrong. Escalation says a
   * colleague's handling was not good enough; folding it into `manage` would
   * make that unavoidable to grant with the ability to work a record at all.
   */
  it("403 escalating with the view and manage keys", async () => {
    const res = await server()
      .post("/crm/issues/rec_1/escalate")
      .set("Authorization", await bearer(["crm:issues:view", "crm:issues:manage"]))
      .send({ reason: "Third missed delivery" });
    expect(res.status).toBe(403);
  });

  /** And the reverse: the escalation key is not a licence to edit the record. */
  it("403 editing a record with the escalate key alone", async () => {
    const res = await server()
      .patch("/crm/issues/rec_1")
      .set("Authorization", await bearer(["crm:issues:escalate"]))
      .send({ severity: "low" });
    expect(res.status).toBe(403);
  });

  it("403 moving a stage with the view key alone", async () => {
    const res = await server()
      .post("/crm/issues/rec_1/stage")
      .set("Authorization", await bearer(["crm:issues:view"]))
      .send({ toStage: "acknowledged" });
    expect(res.status).toBe(403);
  });

  it("lets the view key read the descriptions and every list", async () => {
    for (const path of [
      "/crm/issues/record-types",
      "/crm/issues?recordType=issue",
      "/crm/issues?recordType=task",
      "/crm/issues?recordType=complaint",
    ]) {
      const res = await server()
        .get(path)
        .set("Authorization", await bearer(["crm:issues:view"]));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    }
  });

  /**
   * Another tenant's record reads as absent, never as forbidden: a 403 on an
   * identifier that exists elsewhere turns a probe into an existence oracle.
   */
  it("404s a record that belongs to nobody in this tenant", async () => {
    const res = await server()
      .get("/crm/issues/someone-elses-complaint")
      .set("Authorization", await bearer(["crm:issues:view"]));
    expect([404, 500]).toContain(res.status);
    expect(res.status).not.toBe(403);
  });

  /**
   * The history route resolves the record first, so a caller whose scope
   * excludes it gets the same 404 rather than the escalation history of a record
   * they cannot see.
   */
  it("404s another tenant's history rather than answering it", async () => {
    const res = await server()
      .get("/crm/issues/someone-elses-complaint/transitions")
      .set("Authorization", await bearer(["crm:issues:view"]));
    expect([404, 500]).toContain(res.status);
    expect(res.status).not.toBe(403);
  });

  it("402s the whole surface when the CRM module is off", async () => {
    const token = await signToken({
      permissions: ["crm:issues:view"],
      enabledModules: ALL_MODULES.filter((module) => module !== "crm"),
    });
    const res = await server()
      .get("/crm/issues/record-types")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(402);
  });
});
