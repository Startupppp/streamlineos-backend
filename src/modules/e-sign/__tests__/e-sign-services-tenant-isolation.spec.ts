import type { Db } from "../../../db/drizzle.module";
import { SignSettingsService } from "../sign-settings.service";
import { SignTemplatesService } from "../sign-templates.service";
import { SignReportsService } from "../sign-reports.service";
import { SignAiService } from "../sign-ai.service";
import { SignEnvelopeValidationService } from "../sign-envelope-validation.service";
import { SignBulkSendService } from "../sign-bulk-send.service";
import { SignEnvelopeDispatchService } from "../sign-envelope-dispatch.service";
import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeDb(rows: unknown[] = []): { db: Db; where: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const where = jest.fn().mockResolvedValue(rows);
  const builder: Record<string, unknown> & { then: unknown; catch: unknown; finally: unknown } = {
    from: jest.fn(),
    where,
    limit: jest.fn(),
    orderBy: jest.fn(),
    offset: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    groupBy: jest.fn(),
    then: (fn: (v: unknown) => unknown) => Promise.resolve(rows).then(fn),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows).catch(fn),
    finally: (fn: () => void) => Promise.resolve(rows).finally(fn),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.groupBy as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.limit as jest.Mock).mockReturnValue(builder);
  (builder.offset as jest.Mock).mockReturnValue(builder);

  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);

  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: {
      signOrgSettings: { findFirst, findMany },
      signTemplates: { findFirst, findMany },
      signEnvelopes: { findFirst, findMany },
      signDocuments: { findFirst, findMany },
      signRecipients: { findFirst, findMany },
      signFields: { findFirst, findMany },
      signAuditEvents: { findFirst, findMany },
      signBulkSendJobs: { findFirst, findMany },
      signCertificates: { findFirst, findMany },
    },
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, orgId: OWNER_ORG }]), onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, orgId: OWNER_ORG }]) }), onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, orgId: OWNER_ORG }]) }) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

describe("SignSettingsService — cross-tenant isolation", () => {
  it("getOrCreate: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockAudit = { record: jest.fn() } as any;
    const svc = new SignSettingsService(db, mockAudit);
    await svc.getOrCreate(ATTACKER_ORG);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("getOrCreate: returns/creates settings for own org (control)", async () => {
    const { db } = makeDb([]);
    const mockAudit = { record: jest.fn() } as any;
    const svc = new SignSettingsService(db, mockAudit);
    const result = await svc.getOrCreate(OWNER_ORG);
    expect(result).toBeDefined();
  });
});

describe("SignTemplatesService — cross-tenant isolation", () => {
  it("list: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const mockAudit = { record: jest.fn() } as any;
    const mockTokens = { createPublicToken: jest.fn() } as any;
    const mockPlanLimits = { assertWithinLimit: jest.fn() } as any;
    const svc = new SignTemplatesService(db, mockAudit, mockTokens, mockPlanLimits);
    const result = await svc.list(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const callArg = findMany.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("list: returns templates for own org (control)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, name: "Template A", templateJson: "{}", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    const { db, findMany } = makeDb([row]);
    findMany.mockResolvedValue([row]);
    const mockAudit = { record: jest.fn() } as any;
    const mockTokens = { createPublicToken: jest.fn() } as any;
    const mockPlanLimits = { assertWithinLimit: jest.fn() } as any;
    const svc = new SignTemplatesService(db, mockAudit, mockTokens, mockPlanLimits);
    const result = await svc.list(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});

describe("SignReportsService — cross-tenant isolation", () => {
  it("getSummary: WHERE includes attacker orgId (deny — different org isolation)", async () => {
    const { db, where } = makeDb([{ value: 0, status: "draft", avgHours: null, totalJobs: 0, totalRows: 0, successRows: 0, failedRows: 0, watermarked: false }]);
    const mockSettings = { getOrCreate: jest.fn().mockResolvedValue({ orgId: ATTACKER_ORG, expirationWarningDays: 3 }) } as any;
    const svc = new SignReportsService(db, mockSettings);
    try { await svc.getSummary(ATTACKER_ORG); } catch { /* may throw on undefined rows */ }
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((call: unknown[]) => sqlValues(call[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getSummary: resolves with own org scoped queries (control)", async () => {
    const { db, where } = makeDb([{ value: 0, status: "draft", avgHours: null, totalJobs: 0, totalRows: 0, successRows: 0, failedRows: 0, watermarked: false }]);
    const mockSettings = { getOrCreate: jest.fn().mockResolvedValue({ orgId: OWNER_ORG, expirationWarningDays: 3 }) } as any;
    const svc = new SignReportsService(db, mockSettings);
    try { await svc.getSummary(OWNER_ORG); } catch { /* may throw on undefined rows */ }
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((call: unknown[]) => sqlValues(call[0]));
    expect(allVals).toContain(OWNER_ORG);
    expect(allVals).not.toContain(ATTACKER_ORG);
  });
});

describe("SignAiService — cross-tenant isolation", () => {
  it("summarizeDocument: envelope query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockStorage = { getFileStream: jest.fn() } as any;
    const mockGateway = { chat: jest.fn().mockResolvedValue({ content: "summary" }) } as any;
    const svc = new SignAiService(db, mockStorage, mockGateway);
    await expect(svc.summarizeDocument(ATTACKER_ORG, 999, "user-x")).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("summarizeDocument: uses own org in query (control — same tenant)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockStorage = { getFileStream: jest.fn() } as any;
    const mockGateway = { chat: jest.fn().mockResolvedValue({ content: "summary" }) } as any;
    const svc = new SignAiService(db, mockStorage, mockGateway);
    await expect(svc.summarizeDocument(OWNER_ORG, 999, "user-y")).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeValidationService — cross-tenant isolation", () => {
  it("validate: envelope query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockRecipients = { listForEnvelope: jest.fn().mockResolvedValue([]) } as any;
    const svc = new SignEnvelopeValidationService(db, mockRecipients);
    await expect(svc.validate(ATTACKER_ORG, 999)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("validate: rejects for own org when envelope not found (control — org is scoped correctly)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockRecipients = { listForEnvelope: jest.fn().mockResolvedValue([]) } as any;
    const svc = new SignEnvelopeValidationService(db, mockRecipients);
    await expect(svc.validate(OWNER_ORG, 999)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignBulkSendService — cross-tenant isolation", () => {
  function makeBulkSvc(db: Db) {
    const sharedMock = { record: jest.fn(), getOrCreate: jest.fn().mockResolvedValue({}), listForEnvelope: jest.fn().mockResolvedValue([]), createRecipient: jest.fn(), send: jest.fn(), createFromEnvelope: jest.fn(), create: jest.fn(), createPublicToken: jest.fn() } as any;
    return new SignBulkSendService(db, sharedMock, sharedMock, sharedMock, sharedMock, sharedMock, sharedMock);
  }

  it("listJobs: attacker orgId scoped in findMany query (cross-tenant isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = makeBulkSvc(db);
    const result = await svc.listJobs(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    const callArg = findMany.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
  });

  it("listJobs: own org scoped in findMany query (control — same tenant)", async () => {
    const jobRow = { id: 1, orgId: OWNER_ORG, status: "pending", totalCount: 10 };
    const { db, findMany } = makeDb([jobRow]);
    findMany.mockResolvedValue([jobRow]);
    const svc = makeBulkSvc(db);
    const result = await svc.listJobs(OWNER_ORG);
    expect(result).toHaveLength(1);
    const callArg = findMany.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeDispatchService — cross-tenant isolation", () => {
  function makeDispatchSvc(db: Db) {
    const sharedMock = { record: jest.fn(), getOrCreate: jest.fn().mockResolvedValue({}), listForEnvelope: jest.fn().mockResolvedValue([]), createRecipient: jest.fn(), createPublicToken: jest.fn(), send: jest.fn() } as any;
    const mockValidation = { validate: jest.fn().mockResolvedValue({ isValid: true, errors: [] }) } as any;
    return new SignEnvelopeDispatchService(db, sharedMock, sharedMock, sharedMock, sharedMock, sharedMock, sharedMock, mockValidation);
  }

  it("send: envelope lookup scoped to attacker orgId (deny — cross-tenant isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = makeDispatchSvc(db);
    const actor = { userId: "attacker", orgId: ATTACKER_ORG } as never;
    await expect(svc.send(ATTACKER_ORG, 999, actor)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("send: envelope lookup scoped to own org (control — same tenant)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = makeDispatchSvc(db);
    const actor = { userId: "owner", orgId: OWNER_ORG } as never;
    await expect(svc.send(OWNER_ORG, 999, actor)).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeSweepsService — cross-tenant isolation", () => {
  function makeSweepsSvc(db: Db) {
    const sharedMock = { record: jest.fn(), createPublicToken: jest.fn(), send: jest.fn(), sendReminder: jest.fn() } as any;
    const mockRecipients = { listForEnvelope: jest.fn().mockResolvedValue([]) } as any;
    return new SignEnvelopeSweepsService(db, sharedMock, sharedMock, sharedMock, mockRecipients, sharedMock);
  }

  it("sendManualReminder: envelope lookup scoped to attacker orgId (deny — cross-tenant isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = makeSweepsSvc(db);
    const actor = { userId: "attacker" } as never;
    await expect(svc.sendManualReminder(ATTACKER_ORG, 999, actor)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("sendManualReminder: uses own org in envelope lookup (control — same tenant)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = makeSweepsSvc(db);
    const actor = { userId: "owner" } as never;
    await expect(svc.sendManualReminder(OWNER_ORG, 999, actor)).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});
