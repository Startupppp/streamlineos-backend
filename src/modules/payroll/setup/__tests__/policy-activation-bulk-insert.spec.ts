import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../../../../db/drizzle.module";
import type { AuditService } from "../../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { TemplateComponentDef } from "../../payroll.types";
import type { ActivatePolicyInput } from "../dto/setup.schemas";
import type { PayrollTemplatesService } from "../templates.service";
import { PolicyMutationService } from "../policy-mutation.service";

const ORG = "org-payroll-bulk";
const USER = "user-payroll-bulk";
const POLICY_ID = 51;
const ACTIVATE_INPUT: ActivatePolicyInput = { templateId: 7, payslipLayout: "CLASSIC" };
const ACTOR = { orgId: ORG, userId: USER } as CurrentUserContext;

interface RecordedInsert {
  table: string;
  rows: Record<string, unknown>[];
}

function componentsOf(count: number): TemplateComponentDef[] {
  return Array.from({ length: count }, (_, i) => ({
    code: `C${String(i)}`,
    name: `Component ${String(i)}`,
    type: "EARNING",
    calcMethod: "FIXED",
    taxable: true,
    showOnPayslip: true,
    includeInCtc: true,
    isStatutory: false,
    sortOrder: i,
  }));
}

function makeService(components: TemplateComponentDef[]) {
  const inserts: RecordedInsert[] = [];

  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ maxVersion: 0 }]) }) }),
    insert: (table: PgTable) => ({
      values: (value: Record<string, unknown> | Record<string, unknown>[]) => {
        inserts.push({
          table: getTableName(table),
          rows: Array.isArray(value) ? value : [value],
        });
        return Object.assign(Promise.resolve([{ id: 900 }]), {
          returning: () => Promise.resolve([{ id: 900 }]),
          onConflictDoNothing: () => Promise.resolve([]),
        });
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  };

  const db = {
    query: {
      payrollPolicies: {
        findFirst: () =>
          Promise.resolve({
            id: POLICY_ID,
            orgId: ORG,
            startMonth: "2026-04",
            payDay: 28,
            country: "IN",
          }),
      },
    },
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Db;

  const templates = {
    getById: () =>
      Promise.resolve({ id: 7, key: "custom", defaultComponents: components, defaultToggles: {} }),
  } as unknown as PayrollTemplatesService;

  const audit = { log: () => undefined } as unknown as AuditService;

  return { service: new PolicyMutationService(db, templates, audit), inserts };
}

describe("PolicyMutationService.activate — salary components are one insert per chunk, not one per component", () => {
  function componentInserts(inserts: RecordedInsert[]) {
    return inserts.filter((i) => i.table === "salary_components");
  }

  it("writes 250 components in 2 statements, not 250", async () => {
    const { service, inserts } = makeService(componentsOf(250));

    await service.activate(ACTOR, POLICY_ID, ACTIVATE_INPUT);

    const written = componentInserts(inserts);
    expect(written).toHaveLength(2);
    expect(written.map((i) => i.rows.length)).toEqual([200, 50]);
    expect(written.flatMap((i) => i.rows).map((r) => r["code"])).toEqual(
      componentsOf(250).map((c) => c.code),
    );
  });

  it("writes 12 components in exactly 1 statement carrying all 12 rows", async () => {
    const { service, inserts } = makeService(componentsOf(12));

    await service.activate(ACTOR, POLICY_ID, ACTIVATE_INPUT);

    const written = componentInserts(inserts);
    expect(written).toHaveLength(1);
    expect(written[0]?.rows).toHaveLength(12);
    for (const row of written[0]?.rows ?? []) expect(row["orgId"]).toBe(ORG);
  });

  it("issues no salary_components statement at all when the template has none", async () => {
    const { service, inserts } = makeService([]);

    await service.activate(ACTOR, POLICY_ID, ACTIVATE_INPUT);

    expect(componentInserts(inserts)).toHaveLength(0);
  });
});
