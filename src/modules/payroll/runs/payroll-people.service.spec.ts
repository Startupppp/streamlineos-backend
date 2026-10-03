import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { PayeeEligibilityController } from "./payee-eligibility.controller";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { PayeeEligibilityService } from "./payee-eligibility.service";
import { payrollPeopleSource, summarizePayrollPeople } from "./lib/payroll-people";

const ORG = "org-people";
const dialect = new PgDialect();
const builder = new QueryBuilder();
const realDb = builder as unknown as Db;
const SOURCE_SELECTS = 2;

function dbAnswering(outer: () => Record<string, unknown>): Db {
  let call = 0;
  return {
    select: (fields: Parameters<QueryBuilder["select"]>[0]) =>
      call++ < SOURCE_SELECTS ? builder.select(fields) : outer(),
  } as unknown as Db;
}

type Captured = { where: SQL | undefined; limit: number | undefined };

function listDb(rows: Array<Record<string, unknown>>, captured: Captured): Db {
  const chain: Record<string, unknown> = {};
  chain["from"] = () => chain;
  chain["where"] = (where: SQL | undefined) => {
    captured.where = where;
    return chain;
  };
  chain["orderBy"] = () => chain;
  chain["limit"] = (limit: number) => {
    captured.limit = limit;
    return Promise.resolve(rows);
  };
  return dbAnswering(() => chain);
}

function row(overrides: Record<string, unknown>) {
  return {
    organizationPersonId: "p-1",
    rowKey: "p:p-1",
    displayName: "Asha Rao",
    email: "asha@example.com",
    employeeNumber: null,
    payeeKind: null,
    payeeId: null,
    hasSalary: false,
    eligibility: "needs-payee-link",
    ...overrides,
  };
}

describe("GET /payroll/people — every person the org could pay, with the reason the picker disables the rest", () => {
  it("renders one org-scoped union of directory people and person-less active members, keyed on the seam's payee rule", () => {
    const query = dialect.sqlToQuery(realDb.select().from(payrollPeopleSource(realDb, ORG)).getSQL());

    expect(query.sql).toContain("union all");
    expect(query.sql).toContain('"organization_members"."status" = $');
    expect(query.sql).toContain('"workers"."is_payee"');
    expect(query.sql).toContain('"workers"."deleted_at" is null');
    expect(query.sql).toContain('"organization_people"."deleted_at" is null');
    expect(query.sql).toContain("\"employee_salary_profiles\".\"status\" = 'ACTIVE'");
    expect(query.sql).toContain("not exists (select 1 from \"organization_people\"");
    expect(query.params.filter((param) => param === ORG)).toHaveLength(2);
    expect(query.params.filter((param) => param === "ACTIVE")).toHaveLength(2);
  });

  it("maps payees, salary state and eligibility, and pages by a (name, key) cursor", async () => {
    const captured: Captured = { where: undefined, limit: undefined };
    const service = new PayeeEligibilityService(
      listDb(
        [
          row({ payeeKind: "user", payeeId: "u-1", eligibility: "eligible" }),
          row({ organizationPersonId: "p-2", rowKey: "p:p-2", displayName: "Bo", payeeKind: "worker", payeeId: "w-2", hasSalary: true, eligibility: "has-salary" }),
          row({ organizationPersonId: null, rowKey: "u:u-3", displayName: "Cy" }),
        ],
        captured,
      ),
    );

    const page = await service.listPeople(ORG, { limit: 2 });

    expect(captured.limit).toBe(3);
    expect(page.data).toEqual([
      expect.objectContaining({ organizationPersonId: "p-1", payee: { kind: "user", userId: "u-1" }, hasSalaryProfile: false, eligibility: "eligible" }),
      expect.objectContaining({ organizationPersonId: "p-2", payee: { kind: "worker", workerId: "w-2" }, hasSalaryProfile: true, eligibility: "has-salary" }),
    ]);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();

    const next: Captured = { where: undefined, limit: undefined };
    await new PayeeEligibilityService(listDb([], next)).listPeople(ORG, {
      limit: 2,
      cursor: page.pagination.nextCursor ?? undefined,
      search: "50%_off",
    });
    const rendered = dialect.sqlToQuery(next.where as SQL);
    expect(rendered.params).toEqual(expect.arrayContaining(["%50\\%\\_off%", "Bo", "p:p-2"]));
  });

  it("answers a person with no payee as needs-payee-link instead of dropping them", async () => {
    const service = new PayeeEligibilityService(listDb([row({})], { where: undefined, limit: undefined }));

    const page = await service.listPeople(ORG, { limit: 50 });

    expect(page.data).toEqual([expect.objectContaining({ payee: null, eligibility: "needs-payee-link" })]);
  });

  it("refuses a malformed cursor with 400", async () => {
    const service = new PayeeEligibilityService(listDb([], { where: undefined, limit: undefined }));

    await expect(service.listPeople(ORG, { limit: 50, cursor: "bm9wZQ" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("summarizePayrollPeople — the pre-run blocker readiness names before Generate", () => {
  it("returns the four counts and up to ten named payable-without-salary samples", async () => {
    const results: Array<Array<Record<string, unknown>>> = [
      [{ payable: 3, withSalary: 1, payableWithoutSalary: 2, needsPayeeLink: 4 }],
      [
        { organizationPersonId: "p-1", displayName: "Asha", payeeKind: "user", payeeId: "u-1" },
        { organizationPersonId: null, displayName: "Cy", payeeKind: "user", payeeId: "u-3" },
      ],
    ];
    const limits: number[] = [];
    let call = 0;
    const db = dbAnswering(() => {
        const result = results[call++] ?? [];
        const chain: Record<string, unknown> = {};
        chain["where"] = () => chain;
        chain["orderBy"] = () => chain;
        chain["limit"] = (limit: number) => {
          limits.push(limit);
          return Promise.resolve(result);
        };
        chain["then"] = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
        chain["from"] = () => chain;
        return chain;
    });

    const summary = await summarizePayrollPeople(db, ORG);

    expect(limits).toEqual([10]);
    expect(summary).toEqual({
      payable: 3,
      withSalary: 1,
      payableWithoutSalary: 2,
      needsPayeeLink: 4,
      payableWithoutSalarySample: [
        { organizationPersonId: "p-1", displayName: "Asha", payee: { kind: "user", userId: "u-1" } },
        { organizationPersonId: null, displayName: "Cy", payee: { kind: "user", userId: "u-3" } },
      ],
    });
  });
});

describe("GET /payroll/people — the roster names everyone in the org, so it is read only at payroll:salaries:view scope all", () => {
  const caller: CurrentUserContext = {
    userId: "payroll-admin",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-people",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, false),
  };

  async function controllerFor(scope: DataScope) {
    const listPeople = jest.fn().mockResolvedValue({ data: [], pagination: { limit: 50, hasMore: false, nextCursor: null } });
    const scopeFor = jest.fn().mockResolvedValue(scope);
    const pass = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      controllers: [PayeeEligibilityController],
      providers: [
        { provide: PayeeEligibilityService, useValue: { listPeople } },
        { provide: AccessService, useValue: { scopeFor } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(pass)
      .overrideGuard(ModuleGuard)
      .useValue(pass)
      .overrideGuard(PermissionGuard)
      .useValue(pass)
      .compile();
    return { controller: moduleRef.get(PayeeEligibilityController), listPeople, scopeFor };
  }

  it("lists the caller's own org for an all-scoped holder", async () => {
    const { controller, listPeople, scopeFor } = await controllerFor("all");

    await controller.listPeople({ limit: 50 }, caller);

    expect(scopeFor).toHaveBeenCalledWith(caller, "payroll:salaries:view");
    expect(listPeople).toHaveBeenCalledWith(ORG, { limit: 50 });
  });

  it.each<DataScope>(["own", "team"])("refuses a %s-scoped holder with 404 and never reads the roster", async (scope) => {
    const { controller, listPeople } = await controllerFor(scope);

    await expect(controller.listPeople({ limit: 50 }, caller)).rejects.toBeInstanceOf(NotFoundException);
    expect(listPeople).not.toHaveBeenCalled();
  });
});
