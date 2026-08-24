import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

/**
 * The review feed is the entire oversight mechanism, so who may read it, who may
 * undo from it, and who may switch autonomy off are three different authorities.
 * These assert the gates rather than the rendering.
 */
describe("Autonomy review auth/RBAC (e2e)", () => {
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
      ["the feed", "get", "/crm/autonomy/decisions"],
      ["one entry", "get", "/crm/autonomy/decisions/d-1"],
      ["a reversal", "post", "/crm/autonomy/decisions/d-1/reverse"],
      ["the switches", "get", "/crm/autonomy/switches"],
      ["the scoreboard", "get", "/crm/autonomy/scoreboard"],
      ["the review queue", "get", "/crm/autonomy/review-queue"],
      ["setting a switch", "patch", "/crm/autonomy/switches"],
    ];

    it.each(routes)("401 on %s", async (_label, method, path) => {
      const res = await server()[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  it("403 reading the feed without crm:autonomy:view", async () => {
    const res = await server()
      .get("/crm/autonomy/decisions")
      .set("Authorization", await bearer([]));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  /**
   * Reading is not undoing. A compliance reviewer who may audit every decision
   * is not necessarily someone who may reach into a rep's pipeline and change
   * it, so the reverse key is separate and the read key does not imply it.
   */
  it("403 reversing with the review key alone", async () => {
    const res = await server()
      .post("/crm/autonomy/decisions/d-1/reverse")
      .set("Authorization", await bearer(["crm:autonomy:view"]))
      .send({});
    expect(res.status).toBe(403);
  });

  /**
   * Nor is reading configuring. Turning an action type off changes what the
   * product does for everybody in the organisation.
   */
  it("403 setting a switch with the review key alone", async () => {
    const res = await server()
      .patch("/crm/autonomy/switches")
      .set("Authorization", await bearer(["crm:autonomy:view"]))
      .send({ kind: "stage.advanced", enabled: false });
    expect(res.status).toBe(403);
  });

  it("403 reading the scoreboard without the view key", async () => {
    const res = await server()
      .get("/crm/autonomy/scoreboard")
      .set("Authorization", await bearer([]));
    expect(res.status).toBe(403);
  });

  /**
   * The scoreboard is evidence for deciding whether to enable an action type, so
   * it sits behind the view key rather than the manage key. Hiding the evidence
   * behind the control would invert the decision it exists to inform.
   */
  it("does not require the manage key to read the scoreboard", async () => {
    const res = await server()
      .get("/crm/autonomy/scoreboard")
      .set("Authorization", await bearer(["crm:autonomy:view"]));
    expect(res.status).not.toBe(403);
  });

  it("403 changing the sampling rate or hold window with the view key alone", async () => {
    const res = await server()
      .patch("/crm/autonomy/settings")
      .set("Authorization", await bearer(["crm:autonomy:view"]))
      .send({ shadowSampleRate: 1 });
    expect(res.status).toBe(403);
  });

  it("403 reversing with an unrelated CRM key", async () => {
    const res = await server()
      .post("/crm/autonomy/decisions/d-1/reverse")
      .set("Authorization", await bearer(["crm:deals:read", "crm:deals:update"]))
      .send({});
    expect(res.status).toBe(403);
  });

  /**
   * Payload validation is asserted against the schemas directly, in
   * `dto/autonomy-review.schemas.spec.ts`, rather than over HTTP.
   *
   * Not for speed: the tenant interceptor resolves an organisation's region
   * before a handler runs, so on a database missing migration 0205 every
   * request 500s before validation is reached. A schema test asserts the same
   * contract without depending on that.
   */
});
