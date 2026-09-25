import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";

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

  const LONG_AGO = "2026-01-01";
  const SINCE_JUNE = "2026-06-01";
  const WORKERS = Array.from({ length: 10 }, (_unused, index) => `w${index}`);
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

  async function emailOf(alias: string): Promise<string> {
    const [row] = await rows<{ email: string }>(sql`select email from users where id = ${id(alias)}`);
    return row?.email ?? "";
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
    const homeBuilder = seedOrg(seeded.seedDb)
      .onPlan("ENTERPRISE")
      .withModules("hr")
      .addMember("hrAdmin", { permissionKeys: HR_ADMIN_KEYS })
      // Onboarding admits members, which needs membership authority (an org administrator).
      .addMember("orgAdmin", { permissionKeys: HR_ADMIN_KEYS, standing: "ORG_ADMIN" })
      .addMember("viewer", { permissionKeys: ["hr:employees:view"] })
      // Managers approve their reports' leave; without the key the route skips them to the HR queue.
      .addMember("bossA", { permissionKeys: ["hr:leaves:approve"] })
      .addMember("bossB", { permissionKeys: ["hr:leaves:approve"] })
      .addMember("emp", {})
      .addMember("peer", {})
      // Holds manage and review but sees employees only through an own scope (set below).
      .addMember("scopedLead", { permissionKeys: ["hr:employees:view", "hr:reporting-lines:manage", "hr:reporting-lines:review"] });
    for (const worker of WORKERS) homeBuilder.addMember(worker, {});
    home = await homeBuilder.build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("hr")
      .addMember("admin", { permissionKeys: HR_ADMIN_KEYS })
      .build();

    const people = ["hrAdmin", "orgAdmin", "viewer", "bossA", "bossB", "emp", "peer", "scopedLead"];
    for (const alias of [...people, ...WORKERS]) await employ(home, alias);
    await employ(neighbour, "admin");

    await seeded.seedDb.execute(sql`
      update role_permission_grants set scope = 'own'
      where org_id = ${home.orgId} and permission_key = 'hr:employees:view'
        and role_id in (select role_id from role_assignments where organization_membership_id = ${home.members.scopedLead?.membershipId ?? 0})`);
    await bumpPermissionsVersion(seeded.seedDb, home.orgId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    for (const alias of people) tokens[alias] = await signSeededToken(seeded, id(alias), home.orgId);
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

    it("403s an employee's PUT of their own line and leaves it alone, while they can still read it", async () => {
      const own = await send("put", `/hr/reporting-lines/${id("emp")}`, "emp", { primaryManagerUserId: id("bossB") });
      expect(own.status).toBe(403);
      expect(await currentManagerOf("emp")).toBe(id("bossA"));
      expect((await get("/me/reporting-line", "emp")).status).toBe(200);
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

  describe("request follow-ups", () => {
    let followUpId = "";

    it("asks for more information, takes the employee's reply back to PENDING, then declines with a reason the employee sees", async () => {
      const created = await send("post", "/me/reporting-manager-requests", "emp", {
        reason: "My manager listed here changed again last week, please check.",
      });
      expect(created.status).toBe(201);
      followUpId = created.body.requestId;

      const ask = await send("post", `/hr/reporting-manager-requests/${followUpId}/review`, "hrAdmin", {
        decision: "REQUEST_INFO",
        reviewReason: "Which team lead do you report to now?",
      });
      expect(ask.status).toBe(200);
      expect(ask.body.request.status).toBe("MORE_INFO_REQUIRED");

      const reply = await send("post", `/me/reporting-manager-requests/${followUpId}/respond`, "emp", {
        reason: "I report to the data team lead since the reorganisation.",
      });
      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe("PENDING");

      const declined = await send("post", `/hr/reporting-manager-requests/${followUpId}/review`, "hrAdmin", {
        decision: "REJECT",
        reviewReason: "Your line already shows the data team lead.",
      });
      expect(declined.status).toBe(200);
      expect(declined.body.request.status).toBe("REJECTED");
      const mine = await get("/me/reporting-manager-requests", "emp");
      expect(mine.body.items.find((item: { requestId: string }) => item.requestId === followUpId)).toMatchObject({
        status: "REJECTED",
        reviewReason: "Your line already shows the data team lead.",
      });
      expect(await currentManagerOf("emp")).toBe(id("bossB"));
    });

    it("notifies only reviewers whose employees scope covers the requester", async () => {
      const [outbox] = await rows<{ targets: string[] }>(sql`
        select target_user_ids as targets from notification_outbox
        where org_id = ${home.orgId} and event_key = 'hr.reporting_manager_request.created' and entity_id = ${followUpId}`);
      expect(outbox?.targets).toContain(id("hrAdmin"));
      expect(outbox?.targets).not.toContain(id("scopedLead"));
    });

    it("re-validates on approval: a suggested manager deactivated after filing fails MANAGER_NOT_ELIGIBLE and nothing moves", async () => {
      const filed = await send("post", "/me/reporting-manager-requests", "peer", {
        reason: "I should be reporting to the second boss now, not nobody.",
        suggestedManagerUserId: id("bossB"),
      });
      expect(filed.status).toBe(201);
      const pending = filed.body.requestId;

      const coverage = await get("/hr/reporting-lines/coverage", "hrAdmin");
      expect(coverage.body.pendingReview.map((row: { requestId: string }) => row.requestId)).toContain(pending);
      const scopedCoverage = await get("/hr/reporting-lines/coverage", "scopedLead");
      expect(scopedCoverage.status).toBe(200);
      expect(scopedCoverage.body.pendingReview).toEqual([]);
      expect(scopedCoverage.body.summary.pendingReview).toBe(0);

      await seeded.seedDb.execute(sql`update users set is_active = false where id = ${id("bossB")}`);
      try {
        const approve = await send("post", `/hr/reporting-manager-requests/${pending}/review`, "hrAdmin", {
          decision: "APPROVE",
          reviewReason: "Approving the suggested manager.",
        });
        expect(approve.status).toBe(400);
        expect(approve.body.code).toBe("MANAGER_NOT_ELIGIBLE");
        expect(await currentManagerOf("peer")).toBeNull();
      } finally {
        await seeded.seedDb.execute(sql`update users set is_active = true where id = ${id("bossB")}`);
      }
      const closed = await send("post", `/hr/reporting-manager-requests/${pending}/review`, "hrAdmin", {
        decision: "REJECT",
        reviewReason: "Handled in the quarterly realignment instead.",
      });
      expect(closed.status).toBe(200);
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

  describe("bulk reporting change — scope, cycles, blank rows, confirmation, retries", () => {
    it("shows an own-scoped lead only themselves: others read as EMPLOYEE_NOT_FOUND and other people's jobs are 404", async () => {
      const preview = await send("post", "/hr/reporting-lines/bulk-jobs", "scopedLead", {
        jobReason: "Scoped lead moves their own line",
        rows: [
          { employeeEmail: await emailOf("peer"), primaryManagerEmail: await emailOf("bossB") },
          { employeeEmail: await emailOf("scopedLead"), primaryManagerEmail: await emailOf("bossA") },
        ],
      });
      expect(preview.status).toBe(201);
      expect(preview.body.rows.map((row: { status: string; codes: string[] }) => [row.status, row.codes])).toEqual([
        ["ERROR", ["EMPLOYEE_NOT_FOUND"]],
        ["READY", []],
      ]);

      expect((await get(`/hr/reporting-lines/bulk-jobs/${jobId}`, "scopedLead")).status).toBe(404);
      expect((await get(`/hr/reporting-lines/bulk-jobs/${jobId}/failures.csv`, "scopedLead")).status).toBe(404);
      const scopedList = await get("/hr/reporting-lines/bulk-jobs", "scopedLead");
      expect(scopedList.body.items.map((item: { jobId: string }) => item.jobId)).toEqual([preview.body.jobId]);
      const adminList = await get("/hr/reporting-lines/bulk-jobs", "hrAdmin");
      expect(adminList.body.items.map((item: { jobId: string }) => item.jobId)).toEqual(expect.arrayContaining([jobId, preview.body.jobId]));
    });

    it("marks a loop that exists only inside the file as PRIMARY_CYCLE on both rows", async () => {
      const preview = await send("post", "/hr/reporting-lines/bulk-jobs", "hrAdmin", {
        jobReason: "Swap two people by mistake",
        rows: [
          { employeeEmail: await emailOf("viewer"), primaryManagerEmail: await emailOf("bossB") },
          { employeeEmail: await emailOf("bossB"), primaryManagerEmail: await emailOf("viewer") },
        ],
      });
      expect(preview.status).toBe(201);
      expect(preview.body.rows.map((row: { status: string; codes: string[] }) => [row.status, row.codes.includes("PRIMARY_CYCLE")])).toEqual([
        ["ERROR", true],
        ["ERROR", true],
      ]);
    });

    it("keeps a blank-primary row's CURRENT manager at commit, not the one it had at preview", async () => {
      const preview = await send("post", "/hr/reporting-lines/bulk-jobs", "hrAdmin", {
        jobReason: "Add a project lead as secondary",
        rows: [{ employeeEmail: await emailOf("peer"), secondaryManagerEmail1: await emailOf("bossB") }],
      });
      expect(preview.status).toBe(201);
      expect(preview.body.rows[0]).toMatchObject({ status: "READY", requestedPrimary: null });

      const moved = await send("put", `/hr/reporting-lines/${id("peer")}`, "hrAdmin", { primaryManagerUserId: id("orgAdmin"), reason: "Moved between preview and commit" });
      expect(moved.status).toBe(200);

      const committed = await send("post", `/hr/reporting-lines/bulk-jobs/${preview.body.jobId}/commit`, "hrAdmin", {});
      expect(committed.status).toBe(200);
      expect(committed.body.committedCount).toBe(1);
      expect(await currentManagerOf("peer")).toBe(id("orgAdmin"));
      const [secondary] = await rows<{ n: number }>(sql`
        select count(*)::int as n from hr_reporting_lines l
        join hr_employments e on e.id = l.employment_id join hr_people p on p.id = e.person_id
        join hr_employments me on me.id = l.manager_employment_id join hr_people mp on mp.id = me.person_id
        where l.org_id = ${home.orgId} and p.user_id = ${id("peer")} and mp.user_id = ${id("bossB")} and l.line_type <> 'primary'`);
      expect(Number(secondary?.n)).toBe(1);
    });

    it("gives a secondary manager no approval routing and no team: the primary routes, the secondary's team omits them", async () => {
      // Approval routing and /me/team read lines in force on the database's CURRENT_DATE, while
      // writers date lines by the org's business date; back-date both lines so neither read depends
      // on the hour this runs (see the timezone note in the HRM-15 report).
      expect((await send("put", `/hr/reporting-lines/${id("peer")}`, "hrAdmin", { primaryManagerUserId: id("orgAdmin"), effectiveFrom: LONG_AGO })).status).toBe(200);
      expect((await send("put", `/hr/reporting-lines/${id("emp")}`, "hrAdmin", { primaryManagerUserId: id("bossB"), effectiveFrom: LONG_AGO })).status).toBe(200);
      const route = await get("/me/approvers/leave", "peer");
      expect(route.status).toBe(200);
      expect(route.body).toMatchObject({ rung: "reporting_manager", approver: { userId: id("orgAdmin") } });
      const team = await get("/me/team", "bossB");
      expect(team.status).toBe(200);
      const reports = team.body.reports.map((report: { userId: string }) => report.userId);
      expect(reports).toContain(id("emp"));
      expect(reports).not.toContain(id("peer"));
    });

    it("refuses a 10-row commit without the exact confirmation phrase, then applies it with the phrase", async () => {
      const preview = await send("post", "/hr/reporting-lines/bulk-jobs", "hrAdmin", {
        jobReason: "Move the whole support rota",
        employeeUserIds: WORKERS.map(id),
        primaryManagerUserId: id("bossA"),
      });
      expect(preview.status).toBe(201);
      expect(preview.body).toMatchObject({ readyCount: 10, requiresConfirmation: true, confirmationPhrase: "CONFIRM 10" });

      const missing = await send("post", `/hr/reporting-lines/bulk-jobs/${preview.body.jobId}/commit`, "hrAdmin", {});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe("CONFIRMATION_REQUIRED");
      const wrong = await send("post", `/hr/reporting-lines/bulk-jobs/${preview.body.jobId}/commit`, "hrAdmin", { confirmationPhrase: "CONFIRM 9" });
      expect(wrong.status).toBe(400);
      expect(await currentManagerOf("w0")).toBeNull();

      const confirmed = await send("post", `/hr/reporting-lines/bulk-jobs/${preview.body.jobId}/commit`, "hrAdmin", { confirmationPhrase: "CONFIRM 10" });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatchObject({ status: "COMMITTED", committedCount: 10 });
      expect(await currentManagerOf("w9")).toBe(id("bossA"));
    });

    it("replays a retried preview and commit with the same Idempotency-Key: one job, one line, one notification", async () => {
      const previewKey = randomUUID();
      const body = { jobReason: "Retry-safe single move", rows: [{ employeeEmail: await emailOf("viewer"), primaryManagerEmail: await emailOf("bossA") }] };
      const first = await send("post", "/hr/reporting-lines/bulk-jobs", "hrAdmin", body, previewKey);
      const retry = await send("post", "/hr/reporting-lines/bulk-jobs", "hrAdmin", body, previewKey);
      expect(first.status).toBe(201);
      expect(retry.body.jobId).toBe(first.body.jobId);
      const [jobs] = await rows<{ n: number }>(sql`select count(*)::int as n from hr_reporting_line_bulk_jobs where org_id = ${home.orgId} and job_reason = 'Retry-safe single move'`);
      expect(Number(jobs?.n)).toBe(1);

      const commitKey = randomUUID();
      const committed = await send("post", `/hr/reporting-lines/bulk-jobs/${first.body.jobId}/commit`, "hrAdmin", {}, commitKey);
      const replayed = await send("post", `/hr/reporting-lines/bulk-jobs/${first.body.jobId}/commit`, "hrAdmin", {}, commitKey);
      expect(committed.status).toBe(200);
      expect(replayed.status).toBe(200);
      expect(replayed.body).toEqual(committed.body);
      expect(await currentManagerOf("viewer")).toBe(id("bossA"));
      const [lines] = await rows<{ n: number }>(sql`
        select count(*)::int as n from hr_reporting_lines l join hr_employments e on e.id = l.employment_id join hr_people p on p.id = e.person_id
        where l.org_id = ${home.orgId} and p.user_id = ${id("viewer")} and l.line_type = 'primary'`);
      expect(Number(lines?.n)).toBe(1);
      const [notes] = await rows<{ n: number }>(sql`
        select count(*)::int as n from notification_outbox where org_id = ${home.orgId} and entity_id = ${first.body.jobId}`);
      expect(Number(notes?.n)).toBe(1);
    });
  });

  describe("in-flight approvals keep their owner", () => {
    it("leaves a pending leave with the old manager after the line moves, and routes a new leave to the new manager", async () => {
      const [type] = await rows<{ id: number }>(sql`
        insert into leave_types (org_id, name, days_per_year) values (${home.orgId}, ${"Unpaid leave"}, 0) returning id`);
      const leaveTypeId = Number(type?.id);
      const before = await send("post", "/me/time-off", "emp", { leaveTypeId, startDate: "2027-01-04", endDate: "2027-01-04", reason: "Family commitment that day" });
      expect(before.status).toBe(201);

      const moved = await send("put", `/hr/reporting-lines/${id("emp")}`, "hrAdmin", {
        primaryManagerUserId: id("bossA"),
        reason: "Back to the platform team",
        effectiveFrom: SINCE_JUNE,
      });
      expect(moved.status).toBe(200);

      const after = await send("post", "/me/time-off", "emp", { leaveTypeId, startDate: "2027-02-01", endDate: "2027-02-01", reason: "Moving house on this day" });
      expect(after.status).toBe(201);
      const leaves = await rows<{ start_date: string; approver_id: string }>(sql`
        select start_date::text, approver_id from leave_requests where org_id = ${home.orgId} and user_id = ${id("emp")} order by start_date`);
      expect(leaves).toEqual([
        { start_date: "2027-01-04", approver_id: id("bossB") },
        { start_date: "2027-02-01", approver_id: id("bossA") },
      ]);
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
    it("replays a retried bulk onboarding with the same Idempotency-Key: one employee, one line", async () => {
      const retried = hire({ department: "Engineering" }) as { email: string };
      const key = randomUUID();
      const first = await send("post", "/hr/employees/onboard/bulk", "orgAdmin", { employees: [retried] }, key);
      const again = await send("post", "/hr/employees/onboard/bulk", "orgAdmin", { employees: [retried] }, key);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ created: 1 });
      expect(again.body).toEqual(first.body);
      const [users] = await rows<{ n: number }>(sql`select count(*)::int as n from users where email = ${retried.email}`);
      expect(Number(users?.n)).toBe(1);
      const [lines] = await rows<{ n: number }>(sql`
        select count(*)::int as n from hr_reporting_lines l join hr_employments e on e.id = l.employment_id join hr_people p on p.id = e.person_id
        join users u on u.id = p.user_id where l.org_id = ${home.orgId} and u.email = ${retried.email}`);
      expect(Number(lines?.n)).toBe(1);
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
