import type { Db } from "../../../db/drizzle.module";
import { HrFormsService } from "./hr-forms.service";
import { HrFormsSubmissionsService } from "./hr-forms-submissions.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as Record<string, unknown>;
  return [
    ...(Array.isArray(r["queryChunks"]) ? sqlValues(r["queryChunks"], seen) : []),
    ...("value" in r ? sqlValues(r["value"], seen) : []),
  ];
}

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const builder = {
    from: jest.fn(), where, orderBy: jest.fn(), limit: jest.fn(), offset: jest.fn(),
    leftJoin: jest.fn(), innerJoin: jest.fn(), groupBy: jest.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  const queryProxy = new Proxy({} as Record<string, unknown>, { get: () => ({ findMany, findFirst }) });
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: queryProxy,
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows) }) }),
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn({ select: jest.fn().mockReturnValue(builder), query: queryProxy } as unknown as Db)),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

function isolationArg(where: jest.Mock, findMany: jest.Mock): unknown {
  if (where.mock.calls.length > 0) return where.mock.calls[0]?.[0];
  return (findMany.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.["where"];
}

describe("HrFormsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, title: "Onboarding Form" };

  it("hides HR forms from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const svc = new HrFormsService(db);
    await svc.listForms(ATTACKER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns HR forms for owning org (control — same-tenant access works)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const svc = new HrFormsService(db);
    await svc.listForms(OWNER, { limit: 10 });
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

describe("HrFormsSubmissionsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROW = { id: 1, orgId: OWNER, formSchemaSnapshot: [], data: {} };

  it("hides form submissions from different org (cross-tenant isolation)", async () => {
    const { db, where, findMany } = makeDb([]);
    const mockForms = { loadForm: jest.fn().mockResolvedValue({ id: 1, orgId: ATTACKER }) };
    const mockAudit = { log: jest.fn() };
    const mockWorkflow = { startInstance: jest.fn() };
    const svc = new HrFormsSubmissionsService(db, mockForms as never, mockAudit as never, mockWorkflow as never);
    await svc.listSubmissions(ATTACKER, 1, { limit: 10 }, false);
    expect(sqlValues(isolationArg(where, findMany))).toContain(ATTACKER);
  });

  it("returns form submissions for owning org (control)", async () => {
    const { db, where, findMany } = makeDb([ROW]);
    const mockForms = { loadForm: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER }) };
    const mockAudit = { log: jest.fn() };
    const mockWorkflow = { startInstance: jest.fn() };
    const svc = new HrFormsSubmissionsService(db, mockForms as never, mockAudit as never, mockWorkflow as never);
    await svc.listSubmissions(OWNER, 1, { limit: 10 }, false);
    expect(sqlValues(isolationArg(where, findMany))).toContain(OWNER);
  });
});

function makeMaskDb(submissionRows: unknown[], countRow = { count: submissionRows.length }) {
  let selectCall = 0;
  const makeBuilder = (resolveWith: unknown) => {
    const b: Record<string, unknown> = {};
    const chainMethods = ["from", "where", "orderBy", "limit", "groupBy", "offset"];
    for (const m of chainMethods) b[m] = jest.fn().mockReturnValue(b);
    b["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveWith).then(resolve);
    return b;
  };
  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCall += 1;
      return selectCall === 1 ? makeBuilder(submissionRows) : makeBuilder([countRow]);
    }),
  } as unknown as Db;
  return db;
}

describe("HrFormsSubmissionsService.maskSensitiveData — JSONB formSchemaSnapshot boundary", () => {
  const mockForms = { loadForm: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", schema: [] }) };
  const mockAudit = { log: jest.fn() };
  const mockWorkflow = { startInstance: jest.fn() };

  const baseRow = {
    id: 1, orgId: "org-1", formId: 1, submittedBy: null,
    submittedByName: null, subjectEmployeeId: null, status: "submitted",
    workflowInstanceId: null, data: { name: "Alice" },
    createdAt: new Date(),
  };

  it("redacts every value when formSchemaSnapshot is a plain object, because sensitivity is unknowable", async () => {
    const row = { ...baseRow, formSchemaSnapshot: { fields: [] } };
    const db = makeMaskDb([row]);
    const svc = new HrFormsSubmissionsService(db, mockForms as never, mockAudit as never, mockWorkflow as never);
    const result = await svc.listSubmissions("org-1", 1, { limit: 10 }, false);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.data).toEqual({ name: "[REDACTED]" });
  });

  it("redacts every value when formSchemaSnapshot is null", async () => {
    const row = { ...baseRow, formSchemaSnapshot: null };
    const db = makeMaskDb([row]);
    const svc = new HrFormsSubmissionsService(db, mockForms as never, mockAudit as never, mockWorkflow as never);
    const result = await svc.listSubmissions("org-1", 1, { limit: 10 }, false);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.data).toEqual({ name: "[REDACTED]" });
  });

  it("returns the row unmasked to a sensitive viewer even when the snapshot is malformed", async () => {
    const row = { ...baseRow, formSchemaSnapshot: { fields: [] } };
    const db = makeMaskDb([row]);
    const svc = new HrFormsSubmissionsService(db, mockForms as never, mockAudit as never, mockWorkflow as never);
    const result = await svc.listSubmissions("org-1", 1, { limit: 10 }, true);
    expect(result.data[0]?.data).toEqual({ name: "Alice" });
  });

  it("submit fails closed with 422 when the stored form schema is not a field array", async () => {
    const forms = { loadForm: jest.fn().mockResolvedValue({ id: 1, orgId: "org-1", status: "active", schema: {} }) };
    const tx = { execute: jest.fn().mockResolvedValue([]) };
    const db = { transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)) } as unknown as Db;
    const svc = new HrFormsSubmissionsService(db, forms as never, mockAudit as never, mockWorkflow as never);
    await expect(svc.submit("org-1", 1, { data: { name: "Alice" } }, null, false)).rejects.toMatchObject({ status: 422 });
  });

  it("masks sensitive keys when formSchemaSnapshot is a proper HrFormField array", async () => {
    const snapshot = [
      { key: "name", label: "Name", type: "text", required: true, sensitive: false },
      { key: "ssn", label: "SSN", type: "text", required: true, sensitive: true },
    ];
    const row = { ...baseRow, formSchemaSnapshot: snapshot, data: { name: "Alice", ssn: "123-45-6789" } };
    const db = makeMaskDb([row]);
    const svc = new HrFormsSubmissionsService(db, mockForms as never, mockAudit as never, mockWorkflow as never);
    const result = await svc.listSubmissions("org-1", 1, { limit: 10 }, false);
    expect(result.data[0]?.data).toEqual({ name: "Alice", ssn: "[REDACTED]" });
  });
});
