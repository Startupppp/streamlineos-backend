import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import { StorageService } from "src/modules/storage/storage.service";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * HR documents in the knowledge base, over HTTP, through the real guards, the real RBAC resolver, the real
 * response filter and Postgres row-level security as the application's own non-owner role.
 *
 * The service-level DB specs prove the rules; this proves the ROUTES carry them: that a switch that is off makes
 * the feature 404, that a personal document cannot be classified or published by the person with the most
 * authority, that an employee outside the audience gets the same 404 as for an id that never existed, that another
 * tenant's ids do too, and that taking a document out of the shareable set takes the entry away from readers on
 * the next request. Reads as an ordered story on purpose: each case leaves the state the next one needs.
 */
describe("[seeded-e2e] HR documents in the knowledge base — switch, classify, publish, read, isolate", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let server: never;
  let storage: StorageService;

  let tokens: Record<string, string> = {};
  let neighbourAdminToken = "";
  let deptOne = "";
  let deptTwo = "";
  let policyId = 0;
  let payslipId = 0;
  let neighbourPolicyId = 0;
  let linkId = 0;
  const fileKey = () => `${home.orgId}/hr-documents/${randomUUID()}.pdf`;
  let policyKey = "";

  const bearer = (alias: string) => ({ Authorization: `Bearer ${tokens[alias]}` });
  const get = (path: string, alias: string) => request(server).get(path).set(bearer(alias));
  const send = (method: "post" | "patch" | "put" | "delete", path: string, alias: string, body?: object, key: string = randomUUID()) =>
    request(server)[method](path).set(bearer(alias)).set("Idempotency-Key", key).send(body);

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await seeded.seedDb.execute(query)) as unknown as T[];
  }

  async function unit(orgId: string, kind: "DEPARTMENT" | "LOCATION"): Promise<string> {
    const id = randomUUID();
    await seeded.seedDb.execute(sql`insert into org_units (id, org_id, kind, name, code) values (${id}, ${orgId}, ${kind}, ${`${kind}-${id.slice(0, 6)}`}, ${id.slice(0, 8)})`);
    return id;
  }

  async function employ(fixture: SeededFixture, alias: string, department: string): Promise<void> {
    const person = await rows<{ id: number }>(sql`insert into hr_people (org_id, user_id) values (${fixture.orgId}, ${fixture.members[alias]?.userId}) returning id`);
    await seeded.seedDb.execute(sql`insert into hr_employments (org_id, person_id, employee_number, department_id) values (${fixture.orgId}, ${person[0]?.id}, ${`E-${randomUUID().slice(0, 8)}`}, ${department})`);
  }

  async function document(fixture: SeededFixture, type: string, fileUrl: string): Promise<number> {
    const created = await rows<{ id: number }>(sql`
      insert into documents (org_id, uploaded_by, name, type, file_url, file_name)
      values (${fixture.orgId}, ${fixture.members.admin?.userId}, ${`${type}-${randomUUID().slice(0, 6)}`}, ${type}, ${fileUrl}, 'file.pdf')
      returning id`);
    return Number(created[0]?.id);
  }

  async function linkRowCount(documentId: number): Promise<number> {
    const found = await rows<{ total: number }>(sql`select count(*)::int as total from kb_linked_documents where document_id = ${documentId}`);
    return Number(found[0]?.total);
  }

  async function auditFor(orgId: string, action: string, targetId: number | string) {
    return rows<{ metadata: Record<string, unknown> }>(sql`select metadata from audit_logs where org_id = ${orgId} and action = ${action} and target_id = ${String(targetId)} order by id`);
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer() as never;
    storage = seeded.app.get(StorageService);

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("admin", {
        permissionKeys: ["hr:documents:view", "hr:documents:manage", "hr:documents:publish", "kb:settings:manage", "kb:pages:view"],
      })
      .addMember("manager", { permissionKeys: ["hr:documents:view", "hr:documents:manage"] })
      .addMember("inDept", {})
      .addMember("otherDept", {})
      .addMember("noEmployment", {})
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("admin", {
        permissionKeys: ["hr:documents:view", "hr:documents:manage", "hr:documents:publish", "kb:settings:manage", "kb:pages:view"],
      })
      .build();

    deptOne = await unit(home.orgId, "DEPARTMENT");
    deptTwo = await unit(home.orgId, "DEPARTMENT");
    await employ(home, "inDept", deptOne);
    await employ(home, "otherDept", deptTwo);

    policyKey = fileKey();
    policyId = await document(home, "POLICY", policyKey);
    payslipId = await document(home, "PAYSLIP", fileKey());
    neighbourPolicyId = await document(neighbour, "POLICY", `${neighbour.orgId}/hr-documents/${randomUUID()}.pdf`);

    for (const alias of ["admin", "manager", "inDept", "otherDept", "noEmployment"])
      tokens[alias] = await signSeededToken(seeded, home.members[alias]?.userId ?? "", home.orgId);
    neighbourAdminToken = await signSeededToken(seeded, neighbour.members.admin?.userId ?? "", neighbour.orgId);
  }, 300_000);

  afterAll(async () => {
    tokens = {};
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 180_000);

  it("fixture check — two tenants, and the seeded employees really are employees", () => {
    expect(home.orgId).not.toBe(neighbour.orgId);
    expect(policyId).toBeGreaterThan(0);
    expect(neighbourPolicyId).toBeGreaterThan(0);
  });

  describe("the switch", () => {
    it("is off by default: every member reads three false switches, and every new route answers 404, the admin's included", async () => {
      const config = await get("/kb/hr-link/config", "inDept");
      expect(config.status).toBe(200);
      expect(config.body).toEqual({ link: false, search: false, ai: false });

      for (const [method, path] of [
        ["get", `/hr/documents/${policyId}/classification`],
        ["patch", `/hr/documents/${policyId}/classification`],
        ["put", `/hr/documents/${policyId}/audiences`],
        ["get", `/hr/documents/${policyId}/kb-link`],
        ["post", `/hr/documents/${policyId}/kb-link`],
        ["get", `/hr/documents/${policyId}/versions`],
        ["post", "/hr/documents/kb-link/backfill"],
      ] as const) {
        const response = method === "get" ? await get(path, "admin") : await send(method, path, "admin", method === "patch" ? { classification: "INTERNAL" } : method === "put" ? { audiences: [] } : {});
        expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`);
      }
      expect((await get("/kb/linked-documents", "inDept")).status).toBe(404);
      expect((await get("/kb/linked-documents", "admin")).status).toBe(404);
      expect(await linkRowCount(policyId)).toBe(0);
    });

    it("refuses to turn search on while linking is off, then lets the admin turn linking on, and an employee sees it", async () => {
      const refused = await send("patch", "/kb/settings/hr-link-flags", "admin", { search: true });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("HR_KB_FLAG_ORDER");

      const on = await send("patch", "/kb/settings/hr-link-flags", "admin", { link: true });
      expect(on.status).toBe(200);
      expect(on.body.effective).toEqual({ link: true, search: false, ai: false });

      expect((await get("/kb/hr-link/config", "inDept")).body).toEqual({ link: true, search: false, ai: false });
      expect((await send("patch", "/kb/settings/hr-link-flags", "inDept", { link: false })).status).toBe(403);
      expect((await get("/kb/hr-link/config", "inDept")).body.link).toBe(true);

      await send("patch", "/kb/settings/hr-link-flags", "admin", { link: true });
      const neighbourConfig = await request(server).get("/kb/hr-link/config").set({ Authorization: `Bearer ${neighbourAdminToken}` });
      expect(neighbourConfig.body).toEqual({ link: false, search: false, ai: false });
    });
  });

  describe("classifying", () => {
    it("starts every document as Personal and says what stands in the way", async () => {
      const view = await get(`/hr/documents/${policyId}/classification`, "admin");

      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ classification: "PERSONAL", publishable: false });
      expect(view.body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(["CLASSIFICATION_NOT_SHAREABLE"]);
    });

    it("refuses someone who manages documents but cannot publish, and audits the refusal", async () => {
      const response = await send("patch", `/hr/documents/${policyId}/classification`, "manager", { classification: "INTERNAL" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("PUBLISH_PERMISSION_REQUIRED");
      expect((await get(`/hr/documents/${policyId}/classification`, "admin")).body.classification).toBe("PERSONAL");
      expect((await auditFor(home.orgId, "hr.document.classification_refused", policyId)).length).toBeGreaterThan(0);
    });

    it("lets that same manager move a document OUT of the shareable set without the publish permission", async () => {
      const response = await send("patch", `/hr/documents/${policyId}/classification`, "manager", { classification: "CONFIDENTIAL" });

      expect(response.status).toBe(200);
      expect(response.body.classification).toBe("CONFIDENTIAL");
    });

    it("cannot make a payslip Internal or publish it, even for the admin who holds every key", async () => {
      const classify = await send("patch", `/hr/documents/${payslipId}/classification`, "admin", { classification: "INTERNAL" });
      expect(classify.status).toBe(422);
      expect(classify.body.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
      expect(JSON.stringify(classify.body.details)).toContain("TYPE_NOT_ALLOWED");

      const publish = await send("post", `/hr/documents/${payslipId}/kb-link`, "admin", { audiences: [{ kind: "ALL_EMPLOYEES" }] });
      expect(publish.status).toBe(422);
      expect(publish.body.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
      expect(await linkRowCount(payslipId)).toBe(0);
      expect((await auditFor(home.orgId, "kb.hr_link.publish_refused", payslipId)).length).toBeGreaterThan(0);
    });

    it("classifies a company policy Internal for the publisher and scopes it to one department", async () => {
      const classified = await send("patch", `/hr/documents/${policyId}/classification`, "admin", { classification: "INTERNAL" });
      expect(classified.status).toBe(200);
      expect(classified.body).toMatchObject({ classification: "INTERNAL", publishable: true, linksTakenDown: 0 });

      const audiences = await send("put", `/hr/documents/${policyId}/audiences`, "admin", { audiences: [{ kind: "DEPARTMENT", refId: deptOne }] });
      expect(audiences.status).toBe(200);
      expect(audiences.body.audiences).toEqual([expect.objectContaining({ kind: "DEPARTMENT", refId: deptOne })]);
      expect((await send("put", `/hr/documents/${policyId}/audiences`, "manager", { audiences: [] })).status).toBe(403);
    });
  });

  describe("publishing and reading", () => {
    it("publishes once, replays the same key, and answers 409 to a fresh attempt", async () => {
      const key = randomUUID();
      const first = await send("post", `/hr/documents/${policyId}/kb-link`, "admin", {}, key);
      expect(first.status).toBe(201);
      linkId = first.body.link.id;
      expect(first.body.link).toMatchObject({ status: "active", versionMode: "FOLLOW_LATEST" });

      const replay = await send("post", `/hr/documents/${policyId}/kb-link`, "admin", {}, key);
      expect(replay.status).toBe(201);
      expect(replay.body.link.id).toBe(linkId);

      const again = await send("post", `/hr/documents/${policyId}/kb-link`, "admin", {});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("LINK_ALREADY_ACTIVE");
      expect(await linkRowCount(policyId)).toBe(1);
      expect((await send("post", `/hr/documents/${policyId}/kb-link`, "manager", {})).status).toBe(403);
    });

    it("shows the entry to an employee in the audience, with a badge-ready projection and no storage key", async () => {
      const list = await get("/kb/linked-documents", "inDept");

      expect(list.status).toBe(200);
      const item = list.body.data.find((entry: { id: number }) => entry.id === linkId);
      expect(item).toMatchObject({ source: "HR_DOCUMENT", status: "active", hasFile: true });
      expect(JSON.stringify(list.body)).not.toContain(policyKey);
      expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["fileUrl", "metadata", "uploadedBy", "userId"]));

      const detail = await get(`/kb/linked-documents/${linkId}`, "inDept");
      expect(detail.status).toBe(200);
      expect(detail.body.audiences).toBeNull();
    });

    it("signs a 300 second URL, never caches it, and records the fact without the URL", async () => {
      const signed = "https://signed.example.test/object?X-Amz-Signature=secret-signature";
      const spy = jest.spyOn(storage, "getFileUrl").mockResolvedValue(signed);
      try {
        const response = await send("post", `/kb/linked-documents/${linkId}/open`, "inDept");

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ url: signed, expiresIn: 300 });
        expect(response.headers["cache-control"]).toContain("no-store");
        expect(spy).toHaveBeenCalledWith(home.orgId, policyKey, 300, undefined, { preauthorized: true });
        const audited = await auditFor(home.orgId, "kb.hr_link.document_opened", linkId);
        expect(audited).toHaveLength(1);
        expect(JSON.stringify(audited[0]?.metadata)).not.toContain("secret-signature");
        expect(JSON.stringify(audited[0]?.metadata)).not.toContain(policyKey);
      } finally {
        spy.mockRestore();
      }
    });

    it("gives an employee outside the audience the same 404 as for an id that never existed", async () => {
      const list = await get("/kb/linked-documents", "otherDept");
      expect(list.body.data.map((entry: { id: number }) => entry.id)).not.toContain(linkId);

      const outside = await get(`/kb/linked-documents/${linkId}`, "otherDept");
      const unknown = await get("/kb/linked-documents/2000000000", "otherDept");
      expect(outside.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect({ ...outside.body, correlationId: undefined }).toEqual({ ...unknown.body, correlationId: undefined });

      const spy = jest.spyOn(storage, "getFileUrl").mockResolvedValue("https://never.example.test");
      try {
        expect((await send("post", `/kb/linked-documents/${linkId}/open`, "otherDept")).status).toBe(404);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("shows nothing to a member with no employment, lets a publisher see everything and list what is not live", async () => {
      expect((await get("/kb/linked-documents", "noEmployment")).body.data).toEqual([]);
      expect((await get("/kb/linked-documents", "admin")).body.data.map((entry: { id: number }) => entry.id)).toContain(linkId);
      expect((await get("/kb/linked-documents?status=all", "inDept")).status).toBe(403);
      expect((await get("/kb/linked-documents?status=all", "admin")).status).toBe(200);
      const asPublisher = await get(`/kb/linked-documents/${linkId}`, "admin");
      expect(asPublisher.body.audiences).toEqual([expect.objectContaining({ kind: "DEPARTMENT", refId: deptOne })]);
    });
  });

  describe("searching", () => {
    const ids = (response: { body: { data: Array<{ id: number }> } }) => response.body.data.map((entry) => entry.id);

    it("answers 404 to a search while the search switch is off, and still lists without one", async () => {
      await seeded.seedDb.execute(sql`update documents set name = 'Remote Working Policy', description = 'Equipment and expenses for remote work', category = 'Policies' where id = ${policyId}`);

      for (const alias of ["admin", "inDept"]) expect((await get("/kb/linked-documents?q=remote", alias)).status).toBe(404);
      expect((await get("/kb/linked-documents", "inDept")).status).toBe(200);
      expect((await get("/kb/hr-link/config", "inDept")).body.search).toBe(false);
    });

    it("lets the admin turn search on, and employees see the switch", async () => {
      const on = await send("patch", "/kb/settings/hr-link-flags", "admin", { search: true });

      expect(on.status).toBe(200);
      expect(on.body.effective).toEqual({ link: true, search: true, ai: false });
      expect((await get("/kb/hr-link/config", "inDept")).body).toEqual({ link: true, search: true, ai: false });
    });

    it("finds the entry by its words for someone in the audience, and tells nobody else it exists", async () => {
      expect(ids(await get("/kb/linked-documents?q=remote%20working", "inDept"))).toEqual([linkId]);
      expect(ids(await get("/kb/linked-documents?q=equipment", "inDept"))).toEqual([linkId]);
      expect(ids(await get("/kb/linked-documents?q=remote%20working", "admin"))).toContain(linkId);

      for (const alias of ["otherDept", "noEmployment"]) {
        const found = await get("/kb/linked-documents?q=remote%20working", alias);
        expect(found.status).toBe(200);
        expect(found.body.data).toEqual([]);
        expect(JSON.stringify(found.body)).not.toContain("Remote Working");
      }
    });

    it("finds nothing for words that are not there, nothing for text with no word, and refuses a one-character search", async () => {
      expect((await get("/kb/linked-documents?q=payroll", "inDept")).body.data).toEqual([]);
      const symbols = await get("/kb/linked-documents?q=%3F%21", "inDept");
      expect(symbols.status).toBe(200);
      expect(symbols.body.data).toEqual([]);
      expect((await get("/kb/linked-documents?q=a", "inDept")).status).toBe(400);
    });

    it("lets a publisher search entries that are not live under their own status, and an employee cannot", async () => {
      expect((await get("/kb/linked-documents?q=remote&status=all", "admin")).status).toBe(200);
      expect((await get("/kb/linked-documents?q=remote&status=all", "inDept")).status).toBe(403);
    });

    it("lets the admin turn the assistant switch on only after search, and off again", async () => {
      const on = await send("patch", "/kb/settings/hr-link-flags", "admin", { ai: true });
      expect(on.status).toBe(200);
      expect(on.body.effective).toEqual({ link: true, search: true, ai: true });

      const off = await send("patch", "/kb/settings/hr-link-flags", "admin", { ai: false });
      expect(off.body.effective).toEqual({ link: true, search: true, ai: false });
    });
  });

  describe("tenants", () => {
    it("shows another tenant nothing, and answers its attempts on this tenant's ids with 404 and changes nothing", async () => {
      await request(server).patch("/kb/settings/hr-link-flags").set({ Authorization: `Bearer ${neighbourAdminToken}` }).set("Idempotency-Key", randomUUID()).send({ link: true });
      const asNeighbour = (method: "get" | "post" | "patch" | "put" | "delete", path: string, body?: object) => {
        const call = request(server)[method](path).set({ Authorization: `Bearer ${neighbourAdminToken}` });
        return method === "get" ? call : call.set("Idempotency-Key", randomUUID()).send(body);
      };

      await request(server).patch("/kb/settings/hr-link-flags").set({ Authorization: `Bearer ${neighbourAdminToken}` }).set("Idempotency-Key", randomUUID()).send({ search: true });
      expect((await asNeighbour("get", "/kb/linked-documents")).body.data).toEqual([]);
      expect((await asNeighbour("get", "/kb/linked-documents?q=remote%20working")).body.data).toEqual([]);
      expect((await asNeighbour("get", `/kb/linked-documents/${linkId}`)).status).toBe(404);
      expect((await asNeighbour("post", `/kb/linked-documents/${linkId}/open`)).status).toBe(404);
      expect((await asNeighbour("get", `/hr/documents/${policyId}/classification`)).status).toBe(404);
      expect((await asNeighbour("patch", `/hr/documents/${policyId}/classification`, { classification: "PERSONAL" })).status).toBe(404);
      expect((await asNeighbour("put", `/hr/documents/${policyId}/audiences`, { audiences: [] })).status).toBe(404);
      expect((await asNeighbour("delete", `/hr/documents/${policyId}/kb-link`)).status).toBe(404);
      expect((await asNeighbour("post", `/hr/documents/${policyId}/versions`, { fileUrl: `${neighbour.orgId}/hr-documents/x.pdf` })).status).toBe(404);

      expect((await get(`/hr/documents/${policyId}/classification`, "admin")).body.classification).toBe("INTERNAL");
      expect((await get(`/hr/documents/${policyId}/kb-link`, "admin")).body.link.status).toBe("active");
      expect((await get("/kb/linked-documents", "inDept")).body.data.map((entry: { id: number }) => entry.id)).toContain(linkId);
      expect((await get(`/hr/documents/${neighbourPolicyId}/classification`, "admin")).status).toBe(404);
    });
  });

  describe("withdrawing with a reason", () => {
    it("records the reason a publisher gives, shows it to publishers only, and still withdraws with no body at all", async () => {
      const withReason = await document(home, "POLICY", fileKey());
      const bodyless = await document(home, "POLICY", fileKey());
      for (const id of [withReason, bodyless]) {
        expect((await send("patch", `/hr/documents/${id}/classification`, "admin", { classification: "INTERNAL" })).status).toBe(200);
        await send("put", `/hr/documents/${id}/audiences`, "admin", { audiences: [{ kind: "ALL_EMPLOYEES" }] });
        expect((await send("post", `/hr/documents/${id}/kb-link`, "admin", {})).status).toBe(201);
      }

      const withdrawn = await send("delete", `/hr/documents/${withReason}/kb-link`, "admin", { reason: "Superseded by the 2026 handbook" });
      const plain = await send("delete", `/hr/documents/${bodyless}/kb-link`, "admin");

      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body.link).toMatchObject({ status: "unpublished", unpublishReason: "Superseded by the 2026 handbook" });
      expect(plain.status).toBe(200);
      expect(plain.body.link).toMatchObject({ status: "unpublished", unpublishReason: "manual" });
      const [audit] = await auditFor(home.orgId, "hr.document.kb_unpublished", withReason);
      expect(audit?.metadata).toMatchObject({ reason: "Superseded by the 2026 handbook", reasonGiven: true });
      const linkOf = withdrawn.body.link.id;
      expect((await get(`/kb/linked-documents/${linkOf}`, "admin")).body.unpublishReason).toBe("Superseded by the 2026 handbook");
      expect((await get(`/kb/linked-documents/${linkOf}`, "inDept")).status).toBe(404);
    });

    it("refuses a blank or oversized reason and an unknown key, and leaves the entry live", async () => {
      const id = await document(home, "POLICY", fileKey());
      await send("patch", `/hr/documents/${id}/classification`, "admin", { classification: "INTERNAL" });
      await send("put", `/hr/documents/${id}/audiences`, "admin", { audiences: [{ kind: "ALL_EMPLOYEES" }] });
      await send("post", `/hr/documents/${id}/kb-link`, "admin", {});

      for (const body of [{ reason: "   " }, { reason: "x".repeat(501) }, { reason: "ok", status: "active" }])
        expect((await send("delete", `/hr/documents/${id}/kb-link`, "admin", body)).status).toBe(400);

      expect((await get(`/hr/documents/${id}/kb-link`, "admin")).body.link.status).toBe("active");
    });

    it("refuses someone who cannot publish, and the reason changes nothing for them", async () => {
      const id = await document(home, "POLICY", fileKey());
      await send("patch", `/hr/documents/${id}/classification`, "admin", { classification: "INTERNAL" });
      await send("put", `/hr/documents/${id}/audiences`, "admin", { audiences: [{ kind: "ALL_EMPLOYEES" }] });
      await send("post", `/hr/documents/${id}/kb-link`, "admin", {});

      expect((await send("delete", `/hr/documents/${id}/kb-link`, "manager", { reason: "because" })).status).toBe(403);

      expect((await get(`/hr/documents/${id}/kb-link`, "admin")).body.link.status).toBe("active");
    });
  });

  describe("taking it back", () => {
    it("takes an entry away from every reader on the next request when its document leaves the shareable set", async () => {
      const response = await send("patch", `/hr/documents/${policyId}/classification`, "admin", { classification: "PERSONAL" });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ classification: "PERSONAL", linksTakenDown: 1, audiences: [] });
      expect((await get("/kb/linked-documents", "inDept")).body.data.map((entry: { id: number }) => entry.id)).not.toContain(linkId);
      expect((await get("/kb/linked-documents?q=remote%20working", "inDept")).body.data).toEqual([]);
      expect((await get("/kb/linked-documents?q=remote%20working", "admin")).body.data).toEqual([]);
      expect((await get(`/kb/linked-documents/${linkId}`, "inDept")).status).toBe(404);
      expect((await get(`/kb/linked-documents/${linkId}`, "admin")).body.status).toBe("unpublished");
      expect((await get(`/hr/documents/${policyId}/kb-link`, "admin")).body.link.unpublishReason).toBe("source_no_longer_publishable");
      // The publisher keeps the record to manage it, and the record says nothing about a document that is Personal now.
      expect((await get(`/kb/linked-documents/${linkId}`, "admin")).body).toMatchObject({ name: null, description: null, category: null, documentType: null, fileName: null, hasFile: false });
      const listed = (await get("/kb/linked-documents?status=all", "admin")).body.data.find((entry: { id: number }) => entry.id === linkId);
      expect(listed).toMatchObject({ status: "unpublished", name: null, documentType: null, hasFile: false });
      expect((await get("/kb/linked-documents?status=unpublished&q=remote%20working", "admin")).body.data).toEqual([]);
      const neighbourView = await request(server).get("/kb/linked-documents?status=all").set({ Authorization: `Bearer ${neighbourAdminToken}` });
      expect(neighbourView.status).toBe(200);
      expect(neighbourView.body.data).toEqual([]);
      expect((await auditFor(home.orgId, "hr.document.classified", policyId)).length).toBeGreaterThanOrEqual(3);
    });

  });

  describe("backfilling existing documents", () => {
    let publicPolicy = 0;
    let privatePolicy = 0;
    let payslip = 0;
    const classificationOf = async (documentId: number) => (await rows<{ classification: string }>(sql`select classification from documents where id = ${documentId}`))[0]?.classification;
    const everyoneRows = async (documentId: number) => Number((await rows<{ n: number }>(sql`select count(*)::int as n from document_audiences where document_id = ${documentId} and kind = 'ALL_EMPLOYEES'`))[0]?.n);

    beforeAll(async () => {
      publicPolicy = await document(home, "POLICY", fileKey());
      privatePolicy = await document(home, "OTHER", fileKey());
      payslip = await document(home, "PAYSLIP", fileKey());
      await seeded.seedDb.execute(sql`update documents set is_public = true where id in (${publicPolicy}, ${payslip})`);
    });

    it("refuses someone who manages documents but cannot publish, and unknown body keys", async () => {
      expect((await send("post", "/hr/documents/kb-link/backfill", "manager", {})).status).toBe(403);
      expect((await send("post", "/hr/documents/kb-link/backfill", "admin", { orgId: neighbour.orgId })).status).toBe(400);
      expect(await classificationOf(publicPolicy)).toBe("PERSONAL");
    });

    it("is a dry run by default: says what it would change, and changes nothing", async () => {
      const response = await send("post", "/hr/documents/kb-link/backfill", "admin", {});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ dryRun: true, applied: 0, done: true });
      expect(response.body.eligible).toBeGreaterThanOrEqual(2);
      expect(response.body.sample.map((entry: { documentId: number }) => entry.documentId)).toEqual(expect.arrayContaining([publicPolicy, privatePolicy]));
      expect(response.body.sample.map((entry: { documentId: number }) => entry.documentId)).not.toContain(payslip);
      expect(response.body.skipped.typeNotAllowed).toBeGreaterThanOrEqual(1);
      expect(await classificationOf(publicPolicy)).toBe("PERSONAL");
      expect(await everyoneRows(publicPolicy)).toBe(0);
    });

    it("applies only when told to: Internal for the eligible, all employees only where it was public, a payslip untouched, nothing published", async () => {
      const response = await send("post", "/hr/documents/kb-link/backfill", "admin", { dryRun: false });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ dryRun: false, done: true });
      expect(response.body.applied).toBeGreaterThanOrEqual(2);
      expect(await classificationOf(publicPolicy)).toBe("INTERNAL");
      expect(await everyoneRows(publicPolicy)).toBe(1);
      expect(await classificationOf(privatePolicy)).toBe("INTERNAL");
      expect(await everyoneRows(privatePolicy)).toBe(0);
      expect(await classificationOf(payslip)).toBe("PERSONAL");
      expect(await everyoneRows(payslip)).toBe(0);
      for (const documentId of [publicPolicy, privatePolicy, payslip]) expect(await linkRowCount(documentId)).toBe(0);
    });

    it("is repeatable: what it changed is no longer eligible", async () => {
      const again = await send("post", "/hr/documents/kb-link/backfill", "admin", { dryRun: false });

      expect(again.body).toMatchObject({ applied: 0, eligible: 0 });
    });

    it("never reaches another tenant's documents, and audits each run", async () => {
      expect(await classificationOf(neighbourPolicyId)).toBe("PERSONAL");
      const audited = await rows<{ metadata: { dryRun: boolean } }>(sql`select metadata from audit_logs where org_id = ${home.orgId} and action = 'kb.hr_link.backfill_run' order by id`);
      expect(audited.length).toBeGreaterThanOrEqual(3);
      expect(audited.some((row) => row.metadata.dryRun === true)).toBe(true);
      expect(audited.some((row) => row.metadata.dryRun === false)).toBe(true);
    });
  });

  describe("switching it off", () => {
    it("stops answering when the admin turns the switch back off, and the data stays where it was", async () => {
      const off = await send("patch", "/kb/settings/hr-link-flags", "admin", { link: false });
      expect(off.status).toBe(200);

      expect((await get("/kb/linked-documents", "inDept")).status).toBe(404);
      expect((await get("/kb/linked-documents?q=remote", "inDept")).status).toBe(404);
      expect((await get("/kb/hr-link/config", "inDept")).body).toEqual({ link: false, search: false, ai: false });
      expect((await get(`/hr/documents/${policyId}/classification`, "admin")).status).toBe(404);
      expect(await linkRowCount(policyId)).toBe(1);
    });
  });
});
