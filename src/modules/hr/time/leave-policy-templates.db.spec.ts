/**
 * Ticket 08. The first-visit leave-policy offer, against a real database,
 * because every property that can be wrong is a database property: a refusal
 * that must outlive the browser that made it, an import that must not create a
 * second Casual Leave, and an offer that must be one organisation's alone.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/scratch_hpr ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --forceExit \
 *     --testPathPattern=leave-policy-templates
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { LEAVE_POLICY_TEMPLATES } from "./leave-policy-templates";
import {
  LeavePolicyTemplatesService,
  type LeavePolicyTemplateImportItem,
} from "./leave-policy-templates.service";

const describeDb = dbSpecSuite();

describeDb("first-visit leave policy templates — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "leave-policy-templates.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let service: LeavePolicyTemplatesService;

  const orgId = `qa-leave-tpl-${randomUUID()}`;
  const otherOrgId = `qa-leave-tpl-other-${randomUUID()}`;
  const ownerOf = (org: string) => `qa-owner-${org}`;

  const seedOrg = async (org: string) => {
    const owner = ownerOf(org);
    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${owner}, ${`${owner}@example.test`}, ${"QA Owner"})`;
      const [seq] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(seq?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${org}, ${`QA Leave Co ${org.slice(-6)}`}, ${org}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${org}, ${owner}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)
      `;
    });
  };

  const itemsFor = (
    keys: readonly string[],
    overrides: Partial<LeavePolicyTemplateImportItem> = {},
  ): LeavePolicyTemplateImportItem[] =>
    LEAVE_POLICY_TEMPLATES.filter((template) => keys.includes(template.key)).map(
      (template) => ({
        key: template.key,
        leaveTypeName: template.leaveTypeName,
        policyName: template.policyName,
        daysPerYear: template.daysPerYear,
        carryForward: template.carryForward,
        accrualType: template.accrualType,
        accrualRate: template.accrualRate,
        maxBalance: template.maxBalance ?? undefined,
        carryForwardDays: template.carryForwardDays,
        encashable: template.encashable,
        probationRestricted: template.probationRestricted,
        effectiveFrom: "2026-04-01",
        ...overrides,
      }),
    );

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    service = new LeavePolicyTemplatesService(drizzle(sql, { schema }));
    await seedOrg(orgId);
    await seedOrg(otherOrgId);
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id in (${orgId}, ${otherOrgId})`;
    await sql`delete from users where id in (${ownerOf(orgId)}, ${ownerOf(otherOrgId)})`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  it("offers the three templates to an organisation that has configured nothing", async () => {
    const offer = await service.offer(orgId);

    expect(offer.shouldOffer).toBe(true);
    expect(offer.templates.map((template) => template.key)).toEqual([
      "casual",
      "sick",
      "comp_off",
    ]);
    expect(offer.alreadyPresent).toEqual([]);
    expect(offer.dismissedAt).toBeNull();
  });

  it("creates one leave type and one policy per selected template", async () => {
    const result = await service.importTemplates(orgId, itemsFor(["casual", "sick"]));
    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([]);

    const types = await sql`select name from leave_types where org_id = ${orgId} order by name`;
    expect(types.map((row) => row.name)).toEqual(["Casual Leave", "Sick Leave"]);

    const policies = await sql`select name, accrual_type from leave_policies where org_id = ${orgId} order by name`;
    expect(policies.map((row) => row.name)).toEqual(["Casual Leave", "Sick Leave"]);
    expect(policies[0]?.accrual_type).toBe("MONTHLY");
  });

  it("creates no second Casual Leave when the import is retried, including under a different spelling", async () => {
    const retry = await service.importTemplates(orgId, itemsFor(["casual"]));
    expect(retry.created).toBe(0);
    expect(retry.skipped).toEqual(["casual"]);

    const respelled = await service.importTemplates(
      orgId,
      itemsFor(["casual"], { leaveTypeName: "  casual   leave " }),
    );
    expect(respelled.created).toBe(0);

    const types = await sql`select count(*)::int as n from leave_types where org_id = ${orgId}`;
    expect(types[0]?.n).toBe(2);
  });

  it("stops offering once the organisation has a policy", async () => {
    const offer = await service.offer(orgId);
    expect(offer.policyCount).toBeGreaterThan(0);
    expect(offer.shouldOffer).toBe(false);
    expect(offer.alreadyPresent).toEqual(expect.arrayContaining(["casual", "sick"]));
  });

  it("records a refusal that outlives the browser and is idempotent", async () => {
    const first = await service.dismiss(otherOrgId, ownerOf(otherOrgId));
    const second = await service.dismiss(otherOrgId, ownerOf(otherOrgId));

    expect(second.dismissedAt).toBe(first.dismissedAt);
    const rows = await sql`select count(*)::int as n from hr_leave_policy_template_dismissals where org_id = ${otherOrgId}`;
    expect(rows[0]?.n).toBe(1);

    const offer = await service.offer(otherOrgId);
    expect(offer.dismissedAt).toBe(first.dismissedAt);
    expect(offer.shouldOffer).toBe(false);
    expect(offer.policyCount).toBe(0);
  });

  it("keeps one organisation's refusal and leave types out of another's offer", async () => {
    const rows = await sql`select count(*)::int as n from hr_leave_policy_template_dismissals where org_id = ${orgId}`;
    expect(rows[0]?.n).toBe(0);

    const neighbourTypes = await sql`select count(*)::int as n from leave_types where org_id = ${otherOrgId}`;
    expect(neighbourTypes[0]?.n).toBe(0);
  });
});
