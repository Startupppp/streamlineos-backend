import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * HRM-15 over HTTP: the real guards, the real RBAC resolver, idempotency fences and Postgres RLS
 * as the application's non-owner role. Reads as one ordered story — each case leaves the state the
 * next one needs: policy → direct assignment → self-service request → HR review → bulk change.
 *
 * Every negative is paired with a positive (BE-141): a 403 is shown next to the caller who is let
 * through, a 404 next to the same read succeeding in the owning tenant.
 */
describe("[seeded-e2e] HRM-15 reporting managers — policy, lines, requests, bulk change, isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let server: never;
  let tokens: Record<string, string> = {};
  let neighbourToken = "";
  let requestId = "";
  let jobId = "";

  const HR_ADMIN_KEYS = [
    "hr:employees:view",
    "hr:reporting-lines:manage",
    "hr:reporting-lines:review",
    "hr:reporting-lines:override",
    "hr:onboarding:manage",
  ];

  const id = (alias: string) => home.members[alias]?.userId ?? "";
  const bearer = (alias: string) => ({ Authorization: `Bearer ${tokens[alias]}` });
  const get = (path: string, alias: string) => request(server).get(path).set(bearer(alias));
  const send = (method: "post" | "patch" | "put", path: string, alias: string, body?: object, key: string = randomUUID()) =>
    request(server)[method](path).set(bearer(alias)).set("Idempotency-Key", key).send(body);

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await seeded.seedDb.execute(query)) as unknown as T[];
  }

  async function employ(fixture: SeededFixture, alias: string): Promise<void> {
    const userId = fixture.members[alias]?.userId;
    await seeded.seedDb.execute(sql`update users set email_verified = now(), is_active = true where id = ${userId}`);
    const person = await rows<{ id: number }>(sql`insert into hr_people (org_id, user_id) values (${fixture.orgId}, ${userId}) returning id`);
    await seeded.seedDb.execute(sql`
      insert into hr_employments (org_id, person_id, employee_number, joining_date, is_primary, lifecycle_status)
      values (${fixture.orgId}, ${person[0]?.id}, ${`E-${randomUUID().slice(0, 8)}`}, '2020-01-01', true, 'ACTIVE')`);
  }

  async function auditCount(action: string, targetId: string): Promise<number> {
    const [row] = await rows<{ n: number }>(
      sql`select count(*)::int as n from audit_logs where org_id = ${home.orgId} and action = ${action} and target_id = ${targetId}`,
    );
    return Number(row?.n ?? 0);
  }

  async function currentManagerOf(alias: string): Promise<string | null> {
    const [row] = await rows<{ manager: string | null }>(sql`
      select mp.user_id as manager
      from hr_reporting_lines l
      join hr_employments e on e.org_id = l.org_id and e.id = l.employment_id
      join hr_people p on p.org_id = e.org_id and p.id = e.person_id
      join hr_employments me on me.org_id = l.org_id and me.id = l.manager_employment_id
      join hr_people mp on mp.org_id = me.org_id and mp.id = me.person_id
      where l.org_id = ${home.orgId} and p.user_id = ${id(alias)} and l.line_type = 'primary'
        and l.effective_from <= current_date and l.effective_to >= current_date`);
    return row?.manager ?? null;
  }

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer() as never;

    // Enterprise: the onboarding cases admit more people than a Starter plan's ten seats.
    home = await seedOrg(seeded.seedDb)
      .onPlan("ENTERPRISE")
      .withModules("hr")
      .addMember("hrAdmin", { permissionKeys: HR_ADMIN_KEYS })
      // Onboarding admits members, which needs membership authority (an org administrator).
      .addMember("orgAdmin", { permissionKeys: HR_ADMIN_KEYS, standing: "ORG_ADMIN" })
      .addMember("viewer", { permissionKeys: ["hr:employees:view"] })
      .addMember("bossA", {})
      .addMember("bossB", {})
      .addMember("emp", {})
      .addMember("peer", {})
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("admin", { permissionKeys: HR_ADMIN_KEYS })
      .build();

    for (const alias of ["hrAdmin", "orgAdmin", "viewer", "bossA", "bossB", "emp", "peer"]) await employ(home, alias);
    await employ(neighbour, "admin");

    for (const alias of ["hrAdmin", "orgAdmin", "viewer", "bossA", "bossB", "emp", "peer"])
      tokens[alias] = await signSeededToken(seeded, id(alias), home.orgId);
    neighbourToken = await signSeededToken(seeded, neighbour.members.admin?.userId ?? "", neighbour.orgId);
  }, 300_000);

  afterAll(async () => {
    tokens = {};
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 180_000);

  describe("reporting manager policy", () => {
    it("refuses an unauthenticated read and serves an unconfigured policy's defaults to an employee viewer", async () => {
      expect((await request(server).get("/hr/reporting-manager-policy")).status).toBe(401);

      const policy = await get("/hr/reporting-manager-policy", "viewer");
      expect(policy.status).toBe(200);
      expect(policy.body).toMatchObject({ isConfigured: false, version: 0, maxSecondaryManagersPerEmployee: 0, defaultPrimaryManager: null });
    });

    it("403s a viewer's update and audits the override holder's update, which sets the default manager", async () => {
      const refused = await send("patch", "/hr/reporting-manager-policy", "viewer", { expectedVersion: 0, maxSecondaryManagersPerEmployee: 1 });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("FORBIDDEN");

      const updated = await send("patch", "/hr/reporting-manager-policy", "hrAdmin", {
        expectedVersion: 0,
        defaultPrimaryManagerUserId: id("bossA"),
        maxSecondaryManagersPerEmployee: 1,
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        isConfigured: true,
        version: 1,
        maxSecondaryManagersPerEmployee: 1,
        defaultPrimaryManager: { userId: id("bossA") },
        defaultPrimaryManagerEligible: true,
      });
      expect(await auditCount("hr.reporting_manager_policy.updated", home.orgId)).toBe(1);
    });

    it("replays a retried update with the same Idempotency-Key instead of applying it twice", async () => {
      const key = randomUUID();
      const body = { expectedVersion: 1, requireReasonAfterChanges: 5 };
      const first = await send("patch", "/hr/reporting-manager-policy", "hrAdmin", body, key);
      const retry = await send("patch", "/hr/reporting-manager-policy", "hrAdmin", body, key);

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.body.version).toBe(first.body.version);
      expect(first.body.version).toBe(2);
      const [stored] = await rows<{ version: number }>(sql`select version from hr_reporting_manager_policies where org_id = ${home.orgId}`);
      expect(Number(stored?.version)).toBe(2);
    });

    it("409s a stale expectedVersion", async () => {
      const stale = await send("patch", "/hr/reporting-manager-policy", "hrAdmin", { expectedVersion: 1, requireReasonAfterChanges: 4 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("CONFLICT");
    });
  });

  describe("direct assignment", () => {
    it("403s a viewer's PUT and leaves the line alone; the manage holder's PUT writes an audited line", async () => {
      const refused = await send("put", `/hr/reporting-lines/${id("emp")}`, "viewer", { primaryManagerUserId: id("bossA") });
      expect(refused.status).toBe(403);
      expect(await currentManagerOf("emp")).toBeNull();

      const set = await send("put", `/hr/reporting-lines/${id("emp")}`, "hrAdmin", {
        primaryManagerUserId: id("bossA"),
        reason: "Joined the platform team",
      });
      expect(set.status).toBe(200);
      expect(set.body.line.current).toMatchObject({ managerUserId: id("bossA"), source: "MANUAL", relationshipType: "PRIMARY" });
      expect(set.body.line.permittedActions).toEqual({ manage: true, review: true, override: true });
      expect(await currentManagerOf("emp")).toBe(id("bossA"));
      expect(await auditCount("hr.reporting_line.changed", id("emp"))).toBe(1);
    });

    it("refuses a primary manager who would close a cycle, with the contract code", async () => {
      await send("put", `/hr/reporting-lines/${id("bossA")}`, "hrAdmin", { primaryManagerUserId: id("hrAdmin") });
      const cycle = await send("put", `/hr/reporting-lines/${id("hrAdmin")}`, "hrAdmin", { primaryManagerUserId: id("emp") });
      expect(cycle.status).toBe(400);
      expect(cycle.body.code).toBe("PRIMARY_CYCLE");
    });

    it("hides the change reason from a viewer who cannot manage or review, and shows it to the manager of lines", async () => {
      const viewer = await get(`/hr/reporting-lines/${id("emp")}`, "viewer");
      const admin = await get(`/hr/reporting-lines/${id("emp")}`, "hrAdmin");
      expect(viewer.status).toBe(200);
      expect(viewer.body.current.changeReason).toBeNull();
      expect(admin.body.current.changeReason).toBe("Joined the platform team");
    });

    it("404s another tenant's read of the line, while the owning tenant reads it", async () => {
      const foreign = await request(server).get(`/hr/reporting-lines/${id("emp")}`).set({ Authorization: `Bearer ${neighbourToken}` });
      expect(foreign.status).toBe(404);
      expect((await get(`/hr/reporting-lines/${id("emp")}`, "hrAdmin")).status).toBe(200);
    });

    it("routes the static coverage and manager-candidates paths, not as employee ids", async () => {
      const coverage = await get("/hr/reporting-lines/coverage", "viewer");
      expect(coverage.status).toBe(200);
      expect(coverage.body).toHaveProperty("policyMissing", false);

      const candidates = await get(`/hr/reporting-lines/manager-candidates?excludeUserId=${id("emp")}`, "viewer");
      expect(candidates.status).toBe(200);
      const ids = candidates.body.items.map((item: { userId: string }) => item.userId);
      expect(ids).toContain(id("bossB"));
      expect(ids).not.toContain(id("emp"));
    });
  });

  describe("employee correction request and HR review", () => {
    it("shows the employee their own line without any reason text", async () => {
      const mine = await get("/me/reporting-line", "emp");
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ hasEmployment: true, primary: { manager: { userId: id("bossA") }, changeReason: null } });
    });

    it("files one request, refuses a duplicate with 409, and fans out one notification to reviewers", async () => {
      const created = await send("post", "/me/reporting-manager-requests", "emp", {
        reason: "I moved to the data team in August and report to someone else now.",
        suggestedManagerUserId: id("bossB"),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: "PENDING", suggestedManager: { userId: id("bossB") } });
      requestId = created.body.requestId;

      const duplicate = await send("post", "/me/reporting-manager-requests", "emp", {
        reason: "Filing the same correction again because nothing happened yet.",
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe("REQUEST_DUPLICATE_ACTIVE");

      const outbox = await rows<{ targets: string[] }>(sql`
        select target_user_ids as targets from notification_outbox
        where org_id = ${home.orgId} and event_key = 'hr.reporting_manager_request.created'`);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.targets).toContain(id("hrAdmin"));
      expect(outbox[0]?.targets).not.toContain(id("emp"));
    });

    it("keeps a request to its owner: another employee's cancel is a 404, the owner's list shows it", async () => {
      const foreign = await send("post", `/me/reporting-manager-requests/${requestId}/cancel`, "peer");
      expect(foreign.status).toBe(404);
      const mine = await get("/me/reporting-manager-requests", "emp");
      expect(mine.status).toBe(200);
      expect(mine.body.items.map((item: { requestId: string }) => item.requestId)).toEqual([requestId]);
    });

    it("403s the HR queue for someone without review, and lists the request for a reviewer", async () => {
      expect((await get("/hr/reporting-manager-requests", "bossB")).status).toBe(403);
      const queue = await get("/hr/reporting-manager-requests?status=PENDING", "hrAdmin");
      expect(queue.status).toBe(200);
      expect(queue.body.items[0]).toMatchObject({ requestId, employee: { userId: id("emp") }, currentManager: { userId: id("bossA") } });
    });

    it("404s another tenant's reviewer on the request", async () => {
      const foreign = await request(server)
        .get(`/hr/reporting-manager-requests/${requestId}`)
        .set({ Authorization: `Bearer ${neighbourToken}` });
      expect(foreign.status).toBe(404);
    });

    it("approves: the line moves to the suggested manager, the request resolves, and it is audited", async () => {
      const approved = await send("post", `/hr/reporting-manager-requests/${requestId}/review`, "hrAdmin", {
        decision: "APPROVE",
        reviewReason: "Confirmed with the data team lead.",
      });
      expect(approved.status).toBe(200);
      expect(approved.body.request).toMatchObject({ status: "APPROVED", resolvedAt: expect.any(String) });
      expect(await currentManagerOf("emp")).toBe(id("bossB"));
      expect(await auditCount("hr.reporting_manager_request.reviewed", requestId)).toBe(1);

      const again = await send("post", `/hr/reporting-manager-requests/${requestId}/review`, "hrAdmin", {
        decision: "REJECT",
        reviewReason: "Second thoughts.",
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("REQUEST_INVALID_TRANSITION");
    });
  });

  describe("bulk reporting change", () => {
    it("previews a file into a persisted job, then commits it", async () => {
      const [person] = await rows<{ email: string }>(sql`select email from users where id = ${id("peer")}`);
      const [boss] = await rows<{ email: string }>(sql`select email from users where id = ${id("bossA")}`);
      const preview = await send("post", "/hr/reporting-lines/bulk-jobs", "hrAdmin", {
        jobReason: "Quarterly team realignment",
        rows: [
          { employeeEmail: person?.email ?? "", primaryManagerEmail: boss?.email ?? "" },
          { employeeEmail: "nobody@example.invalid", primaryManagerEmail: boss?.email ?? "" },
        ],
      });
      expect(preview.status).toBe(201);
      expect(preview.body).toMatchObject({ status: "PREVIEWED", rowCount: 2, readyCount: 1, errorCount: 1, requiresConfirmation: false });
      jobId = preview.body.jobId;

      const committed = await send("post", `/hr/reporting-lines/bulk-jobs/${jobId}/commit`, "hrAdmin", {});
      expect(committed.status).toBe(200);
      expect(committed.body).toMatchObject({ status: "COMMITTED", committedCount: 1 });
      expect(await currentManagerOf("peer")).toBe(id("bossA"));

      const failures = await get(`/hr/reporting-lines/bulk-jobs/${jobId}/failures.csv`, "hrAdmin");
      expect(failures.status).toBe(200);
      expect(failures.headers["content-type"]).toContain("text/csv");
      expect(failures.text).toContain("nobody@example.invalid");

      const list = await get("/hr/reporting-lines/bulk-jobs", "hrAdmin");
      expect(list.status).toBe(200);
      expect(list.body.items[0]).toMatchObject({ jobId, status: "COMMITTED" });
    });

    it("409s a second commit of the same job, and 404s another tenant's read of it", async () => {
      const again = await send("post", `/hr/reporting-lines/bulk-jobs/${jobId}/commit`, "hrAdmin", {});
      expect(again.status).toBe(409);
      const foreign = await request(server).get(`/hr/reporting-lines/bulk-jobs/${jobId}`).set({ Authorization: `Bearer ${neighbourToken}` });
      expect(foreign.status).toBe(404);
      expect((await get(`/hr/reporting-lines/bulk-jobs/${jobId}`, "hrAdmin")).status).toBe(200);
    });
  });

  describe("onboarding", () => {
    const hire = (overrides: object = {}) => ({
      firstName: "New",
      lastName: "Hire",
      email: `hire-${randomUUID().slice(0, 8)}@example.invalid`,
      designation: "Analyst",
      ...overrides,
    });

    it("onboards a hire with no manager to the policy's configured default, and says so", async () => {
      const onboarded = await send("post", "/hr/employees/onboard", "orgAdmin", hire());
      expect(onboarded.status).toBe(201);
      expect(onboarded.body).toMatchObject({
        success: true,
        primaryManager: { userId: id("bossA"), resolution: "FALLBACK_CONFIGURED" },
      });
      const [line] = await rows<{ source: string }>(sql`
        select l.source from hr_reporting_lines l
        join hr_employments e on e.org_id = l.org_id and e.id = l.employment_id
        join hr_people p on p.org_id = e.org_id and p.id = e.person_id
        where l.org_id = ${home.orgId} and p.user_id = ${onboarded.body.userId} and l.line_type = 'primary'`);
      expect(line?.source).toBe("ONBOARDING_FALLBACK");
    });

    it("refuses a named manager who is not eligible and creates nobody", async () => {
      const email = `refused-${randomUUID().slice(0, 8)}@example.invalid`;
      const refused = await send("post", "/hr/employees/onboard", "orgAdmin", hire({ email, reportingManagerUserId: randomUUID() }));
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("MANAGER_NOT_FOUND");
      const [user] = await rows<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`);
      expect(Number(user?.n)).toBe(0);
    });

    it("previews a bulk file per row with the legacy header, then commits only the rows it accepted", async () => {
      const [boss] = await rows<{ email: string }>(sql`select email from users where id = ${id("bossB")}`);
      const file = [
        hire({ department: "Engineering", reportingManagerEmail: boss?.email }),
        hire({ department: "Engineering" }),
        hire({ department: "Engineering", primaryManagerEmail: "ghost@example.invalid" }),
      ];
      const preview = await send("post", "/hr/employees/onboard/bulk/preview", "orgAdmin", { employees: file });
      expect(preview.status).toBe(200);
      expect(preview.body.rows.map((row: { status: string }) => row.status)).toEqual(["WARNING", "WARNING", "ERROR"]);
      expect(preview.body.rows[0].primaryManager).toMatchObject({ userId: id("bossB"), resolution: "IN_FILE" });
      expect(preview.body.rows[1].primaryManager).toMatchObject({ userId: id("bossA"), resolution: "FALLBACK_CONFIGURED" });
      expect(preview.body.rows[2].codes).toEqual(["MANAGER_NOT_FOUND"]);
      const [nothing] = await rows<{ n: number }>(sql`select count(*)::int as n from users where email = ${file[0]?.email ?? ""}`);
      expect(Number(nothing?.n)).toBe(0);

      const committed = await send("post", "/hr/employees/onboard/bulk", "orgAdmin", { employees: file });
      expect(committed.status).toBe(200);
      expect(committed.body).toMatchObject({ total: 3, created: 2, failed: 1, skipped: 0 });
      expect(committed.body.results.map((result: { status: string }) => result.status)).toEqual(["CREATED", "CREATED", "FAILED"]);
      const [audit] = await rows<{ metadata: { legacyManagerHeader: boolean } }>(
        sql`select metadata from audit_logs where org_id = ${home.orgId} and action = 'hr.employees_bulk_onboarded' order by id desc limit 1`,
      );
      expect(audit?.metadata.legacyManagerHeader).toBe(true);
    });
    it("onboards a report whose manager is created by the same file, manager first", async () => {
      const lead = hire({ department: "Engineering" }) as { email: string };
      const report = hire({ department: "Engineering", primaryManagerEmail: lead.email });
      const preview = await send("post", "/hr/employees/onboard/bulk/preview", "orgAdmin", { employees: [report, lead] });
      expect(preview.status).toBe(200);
      expect(preview.body.rows[0]).toMatchObject({ status: "READY", primaryManager: { userId: null, resolution: "IN_FILE" } });

      const committed = await send("post", "/hr/employees/onboard/bulk", "orgAdmin", { employees: [report, lead] });
      expect(committed.status).toBe(200);
      expect(committed.body).toMatchObject({ created: 2, failed: 0 });
      const [line] = await rows<{ manager_email: string; source: string }>(sql`
        select mu.email as manager_email, rl.source
        from hr_reporting_lines rl
        join hr_employments se on se.id = rl.employment_id
        join hr_people sp on sp.id = se.person_id
        join users su on su.id = sp.user_id
        join hr_employments me on me.id = rl.manager_employment_id
        join hr_people mp on mp.id = me.person_id
        join users mu on mu.id = mp.user_id
        where rl.org_id = ${home.orgId} and su.email = ${report.email} and rl.line_type = 'primary'`);
      expect(line).toEqual({ manager_email: lead.email, source: "BULK_ONBOARDING" });
    });
  });
});
