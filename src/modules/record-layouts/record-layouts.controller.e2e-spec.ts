import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { RecordLayoutsService } from "./record-layouts.service";

const MANAGE = "settings:record-layouts:manage";
const ORG_A = "org_a";
const ORG_B = "org_b";

/**
 * Who may read an arrangement, who may change one, and whose arrangement they
 * get.
 *
 * The third is the one that cannot be asserted anywhere else. `orgId` is taken
 * from `@CurrentUser()` and never from the request, so the only way to prove
 * that is to send two tokens for two organisations at the same URL and watch
 * which row each one reaches. The service is stubbed with a per-tenant store
 * that answers the way the table does — a stub that ignored `orgId` would pass
 * every case here while proving nothing, which is exactly what this file exists
 * to rule out.
 */
function makeStore() {
  const rows = new Map<string, { layoutKey: string; hidden: string[] }>();
  const calls: { method: string; orgId: string; layoutKey: string }[] = [];
  const at = (orgId: string, layoutKey: string) => `${orgId}::${layoutKey}`;

  const stub = {
    async get(orgId: string, layoutKey: string) {
      calls.push({ method: "get", orgId, layoutKey });
      return rows.get(at(orgId, layoutKey)) ?? null;
    },
    async save(
      orgId: string,
      _userId: string,
      layoutKey: string,
      body: { hidden?: string[] },
    ) {
      calls.push({ method: "save", orgId, layoutKey });
      const stored = { layoutKey, hidden: body.hidden ?? [] };
      rows.set(at(orgId, layoutKey), stored);
      return stored;
    },
    async remove(orgId: string, layoutKey: string) {
      calls.push({ method: "remove", orgId, layoutKey });
      rows.delete(at(orgId, layoutKey));
      return null;
    },
    async usage(orgId: string, layoutKey: string) {
      calls.push({ method: "usage", orgId, layoutKey });
      return { sample: 40, cap: 500, filled: { name: 40 }, uncounted: [] };
    },
  };

  return { stub, rows, calls };
}

describe("Record layouts auth/RBAC and tenant isolation (e2e)", () => {
  let app: INestApplication;
  const store = makeStore();

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: RecordLayoutsService, useValue: store.stub }],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    store.rows.clear();
    store.calls.length = 0;
  });

  const server = () => request(app.getHttpServer());

  /**
   * `settings` is named alongside the registry's modules deliberately.
   *
   * It has no `MODULE_REGISTRY` entry — it is a platform surface, not a
   * subscription — so `isCoreModuleKey("settings")` is true and production never
   * gates it. The harness pins `isCoreModule` to false so that availability is
   * decided by the token alone, which means the fixture has to say what
   * production would have answered. Without it every gated route here returns
   * 402 and the RBAC assertions below would be testing the module tier.
   */
  const bearer = async (permissions: string[], orgId = ORG_A) =>
    `Bearer ${await signToken({
      orgId,
      permissions,
      enabledModules: [...ALL_MODULES, "settings"],
    })}`;

  describe("no token at all", () => {
    const routes: ReadonlyArray<[string, "get" | "put" | "delete", string]> = [
      ["reading an arrangement", "get", "/renderer/layouts/crm:lead"],
      ["saving one", "put", "/renderer/layouts/crm:lead"],
      ["resetting one", "delete", "/renderer/layouts/crm:lead"],
      ["the usage sample", "get", "/renderer/layouts/crm:lead/usage"],
    ];

    it.each(routes)("401 on %s", async (_label, method, path) => {
      const res = await server()[method](path).send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  /**
   * The design decision, asserted rather than described: an arrangement holds
   * only field names the description already publishes, and every record surface
   * reads it to render at all. A user with no permissions whatsoever gets it.
   */
  it("reads an arrangement with no permission key at all", async () => {
    const res = await server()
      .get("/renderer/layouts/crm:lead")
      .set("Authorization", await bearer([]));

    expect(res.status).toBe(200);
    expect(store.calls).toEqual([{ method: "get", orgId: ORG_A, layoutKey: "crm:lead" }]);
  });

  it("answers null for a tenant that has never arranged anything", async () => {
    const res = await server()
      .get("/renderer/layouts/party")
      .set("Authorization", await bearer([]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  describe("changing an arrangement is gated", () => {
    it("403 saving without the key", async () => {
      const res = await server()
        .put("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer(["settings:view", "crm:leads:read"]))
        .send({ hidden: ["notes"] });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
      expect(store.calls).toEqual([]);
    });

    it("403 resetting without the key", async () => {
      const res = await server()
        .delete("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([]));
      expect(res.status).toBe(403);
    });

    it("403 reading the usage sample without the key", async () => {
      // Counts are a summary of the tenant's records, which the arrangement is
      // not. Reading one is not implied by reading the other.
      const res = await server()
        .get("/renderer/layouts/crm:lead/usage")
        .set("Authorization", await bearer([]));
      expect(res.status).toBe(403);
    });

    it("403 with the placeholder key the frontend gated on before this shipped", async () => {
      const res = await server()
        .put("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer(["settings:manage"]))
        .send({ hidden: ["notes"] });
      expect(res.status).toBe(403);
    });

    it("200 with the key", async () => {
      const res = await server()
        .put("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([MANAGE]))
        .send({ hidden: ["notes"] });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ layoutKey: "crm:lead", hidden: ["notes"] });
    });

    it("200 resetting with the key", async () => {
      const auth = await bearer([MANAGE]);
      await server().put("/renderer/layouts/crm:lead").set("Authorization", auth).send({});
      const res = await server()
        .delete("/renderer/layouts/crm:lead")
        .set("Authorization", auth);

      expect(res.status).toBe(200);
      expect(store.rows.size).toBe(0);
    });

    it("200 on the usage sample with the key, and it says its cap", async () => {
      const res = await server()
        .get("/renderer/layouts/crm:lead/usage")
        .set("Authorization", await bearer([MANAGE]));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sample: 40, cap: 500 });
    });
  });

  describe("one tenant never reaches another's arrangement", () => {
    it("reads its own row at the same URL", async () => {
      await server()
        .put("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([MANAGE], ORG_A))
        .send({ hidden: ["notes"] });

      const mine = await server()
        .get("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([], ORG_A));
      const theirs = await server()
        .get("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([], ORG_B));

      expect(mine.body).toMatchObject({ hidden: ["notes"] });
      expect(theirs.body).toEqual({});
    });

    it("cannot write into another organisation by naming it in the body", async () => {
      // `.strict()` refuses the key outright, which is stronger than ignoring
      // it: a body that silently dropped `orgId` would look like it worked.
      const res = await server()
        .put("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([MANAGE], ORG_A))
        .send({ orgId: ORG_B, hidden: ["notes"] });

      expect(res.status).toBe(400);
      expect(store.calls).toEqual([]);
    });

    it("cannot write into another organisation by naming it in the query", async () => {
      await server()
        .put("/renderer/layouts/crm:lead?orgId=org_b&organizationId=org_b")
        .set("Authorization", await bearer([MANAGE], ORG_A))
        .send({ hidden: ["notes"] });

      expect(store.calls).toEqual([{ method: "save", orgId: ORG_A, layoutKey: "crm:lead" }]);
    });

    it("cannot delete another organisation's arrangement", async () => {
      await server()
        .put("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([MANAGE], ORG_B))
        .send({ hidden: ["city"] });

      await server()
        .delete("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([MANAGE], ORG_A));

      const theirs = await server()
        .get("/renderer/layouts/crm:lead")
        .set("Authorization", await bearer([], ORG_B));
      expect(theirs.body).toMatchObject({ hidden: ["city"] });
    });

    it("counts only the caller's own records", async () => {
      await server()
        .get("/renderer/layouts/crm:lead/usage")
        .set("Authorization", await bearer([MANAGE], ORG_B));

      expect(store.calls).toEqual([
        { method: "usage", orgId: ORG_B, layoutKey: "crm:lead" },
      ]);
    });
  });

  describe("the layout key is checked before anything is stored", () => {
    it.each([
      ["a record type nobody renders", "crm:invoice"],
      ["a near miss", "crm:leads"],
      ["SQL", "crm:lead';DROP TABLE record_layout_adjustments;--"],
    ])("400 saving an arrangement for %s", async (_label, key) => {
      const res = await server()
        .put(`/renderer/layouts/${encodeURIComponent(key)}`)
        .set("Authorization", await bearer([MANAGE]))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(store.calls).toEqual([]);
    });

    it("400 reading an unknown layout, even though reading is ungated", async () => {
      const res = await server()
        .get("/renderer/layouts/crm:invoice")
        .set("Authorization", await bearer([]));
      expect(res.status).toBe(400);
    });
  });

  /**
   * Hiding the title field, hiding a required one, and naming a field the layout
   * does not publish are asserted in `dto/record-layouts.schemas.spec.ts` and
   * `record-layouts.service.spec.ts` rather than here.
   *
   * They cannot be asserted through this harness and be meaningful: those checks
   * need the layout the key names, so they live in the service, which this file
   * replaces with a store in order to watch which tenant each request reaches.
   * A stub that re-ran the real validation would be asserting the stub. Same
   * argument `issues.controller.e2e-spec.ts` makes about payload validation.
   *
   * What IS controller-level is asserted above: the layout key, and a body
   * carrying a field the schema does not accept.
   */
});
