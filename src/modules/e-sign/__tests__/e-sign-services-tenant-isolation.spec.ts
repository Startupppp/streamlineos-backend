import { NotFoundException } from "@nestjs/common";
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
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeBuilder(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where,
    limit: jest.fn(),
    offset: jest.fn(),
    orderBy: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    groupBy: jest.fn(),
    for: jest.fn(),
    returning: jest.fn().mockResolvedValue(rows),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown[]) => void) => Promise.resolve(rows).then(resolve),
    ),
  };
  for (const key of ["from", "where", "limit", "offset", "orderBy", "leftJoin", "innerJoin", "groupBy", "for"]) {
    (builder[key] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where: where as jest.Mock };
}

function makeInsertBuilder(rows: unknown[] = [{ id: 1, orgId: OWNER_ORG }]) {
  const ib: Record<string, unknown> = {
    values: jest.fn(),
    onConflictDoNothing: jest.fn(),
    onConflictDoUpdate: jest.fn(),
    returning: jest.fn().mockResolvedValue(rows),
    then: jest.fn().mockImplementation(
      (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
    ),
  };
  (ib.values as jest.Mock).mockReturnValue(ib);
  (ib.onConflictDoNothing as jest.Mock).mockReturnValue(ib);
  (ib.onConflictDoUpdate as jest.Mock).mockReturnValue(ib);
  return ib;
}

function makeDb(rows: unknown[] = []) {
  const { builder, where } = makeBuilder(rows);
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
      signBulkSendRows: { findFirst, findMany },
      users: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnValue(makeInsertBuilder()),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

const mockAudit = { record: jest.fn() };
const mockTokens = { createPublicToken: jest.fn() };
const mockPlanLimits = { assertWithinLimit: jest.fn() };
const mockNotifications = { sendRecipientInvite: jest.fn(), sendCompletionNotice: jest.fn() };
const mockRecipients = { listForEnvelope: jest.fn().mockResolvedValue([]) };
const mockIntegrations = { syncSignedDoc: jest.fn() };
const mockStorage = { getFileStream: jest.fn() };
const mockGateway = { chat: jest.fn().mockResolvedValue({ content: "summary" }) };

describe("SignSettingsService — cross-tenant isolation", () => {
  it("getOrCreate: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignSettingsService(db, mockAudit as never);
    await svc.getOrCreate(ATTACKER_ORG);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("getOrCreate: creates default settings for own org (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const svc = new SignSettingsService(db, mockAudit as never);
    const result = await svc.getOrCreate(OWNER_ORG);
    expect(result).toBeDefined();
  });
});

describe("SignTemplatesService — cross-tenant isolation", () => {
  it("list: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = new SignTemplatesService(db, mockAudit as never, mockTokens as never, mockPlanLimits as never);
    const result = await svc.list(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const callArg = findMany.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("list: returns templates for own org (control — same-tenant)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, name: "Template A", templateJson: "{}", status: "draft" };
    const { db, findMany } = makeDb([row]);
    findMany.mockResolvedValue([row]);
    const svc = new SignTemplatesService(db, mockAudit as never, mockTokens as never, mockPlanLimits as never);
    const result = await svc.list(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});

describe("SignReportsService — cross-tenant isolation", () => {
  it("getSummary: WHERE contains attacker orgId (deny — different org isolation)", async () => {
    const countRow = { value: 0, status: "draft", count: 0, avgHours: null, totalJobs: 0, totalRows: 0, successRows: 0, failedRows: 0 };
    const { db, where } = makeDb([countRow]);
    const mockSettings = { getOrCreate: jest.fn().mockResolvedValue({ orgId: ATTACKER_ORG, expirationWarningDays: 3 }) };
    const svc = new SignReportsService(db, mockSettings as never);
    await svc.getSummary(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((c) => sqlValues(c[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getSummary: resolves for own org (control — same-tenant)", async () => {
    const countRow = { value: 0, status: "draft", count: 0, avgHours: null, totalJobs: 0, totalRows: 0, successRows: 0, failedRows: 0 };
    const { db } = makeDb([countRow]);
    const mockSettings = { getOrCreate: jest.fn().mockResolvedValue({ orgId: OWNER_ORG, expirationWarningDays: 3 }) };
    const svc = new SignReportsService(db, mockSettings as never);
    await expect(svc.getSummary(OWNER_ORG)).resolves.toBeDefined();
  });
});

describe("SignAiService — cross-tenant isolation", () => {
  it("summarizeDocument: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignAiService(db, mockStorage as never, mockGateway as never);
    await expect(svc.summarizeDocument(ATTACKER_ORG, 999, "user-x")).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("summarizeDocument: uses own org in envelope query (control — same-tenant throws correctly)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignAiService(db, mockStorage as never, mockGateway as never);
    await expect(svc.summarizeDocument(OWNER_ORG, 999, "user-y")).rejects.toThrow(NotFoundException);
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeValidationService — cross-tenant isolation", () => {
  it("validate: envelope query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignEnvelopeValidationService(db, mockRecipients as never);
    await expect(svc.validate(ATTACKER_ORG, 999)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("validate: query uses own orgId when envelope absent (control — same-tenant)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignEnvelopeValidationService(db, mockRecipients as never);
    await expect(svc.validate(OWNER_ORG, 999)).rejects.toThrow(NotFoundException);
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignBulkSendService — cross-tenant isolation", () => {
  it("listJobs: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findMany } = makeDb([]);
    const mockTemplates = { list: jest.fn().mockResolvedValue([]), get: jest.fn(), createFromEnvelope: jest.fn(), create: jest.fn() };
    const mockEnvelopes = { create: jest.fn(), send: jest.fn() };
    const svc = new SignBulkSendService(db, mockAudit as never, {} as never, mockNotifications as never, mockTemplates as never, mockEnvelopes as never, mockIntegrations as never);
    const result = await svc.listJobs(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalled();
    const callArg = findMany.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("listJobs: returns empty for own org with no jobs (control — same-tenant)", async () => {
    const { db } = makeDb([]);
    const mockTemplates = { list: jest.fn().mockResolvedValue([]), get: jest.fn(), createFromEnvelope: jest.fn(), create: jest.fn() };
    const mockEnvelopes = { create: jest.fn(), send: jest.fn() };
    const svc = new SignBulkSendService(db, mockAudit as never, {} as never, mockNotifications as never, mockTemplates as never, mockEnvelopes as never, mockIntegrations as never);
    const result = await svc.listJobs(OWNER_ORG);
    expect(result).toHaveLength(0);
  });
});

describe("SignEnvelopeDispatchService — cross-tenant isolation", () => {
  it("send: envelope lookup scoped to attacker orgId (deny — different org isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockValidation = { validate: jest.fn().mockResolvedValue({ isValid: true, errors: [] }) };
    const mockSweeps = { sendManualReminder: jest.fn() };
    const svc = new SignEnvelopeDispatchService(
      db,
      mockAudit as never,
      mockTokens as never,
      {} as never,
      mockNotifications as never,
      mockRecipients as never,
      mockIntegrations as never,
      mockValidation as never,
      mockSweeps as never,
    );
    const actor = { userId: "attacker", orgId: ATTACKER_ORG } as never;
    await expect(svc.send(ATTACKER_ORG, 999, actor)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("send: envelope lookup uses own org (control — same-tenant throws correctly)", async () => {
    const { db, findFirst } = makeDb([]);
    const mockValidation = { validate: jest.fn().mockResolvedValue({ isValid: true, errors: [] }) };
    const mockSweeps = { sendManualReminder: jest.fn() };
    const svc = new SignEnvelopeDispatchService(
      db,
      mockAudit as never,
      mockTokens as never,
      {} as never,
      mockNotifications as never,
      mockRecipients as never,
      mockIntegrations as never,
      mockValidation as never,
      mockSweeps as never,
    );
    const actor = { userId: "owner", orgId: OWNER_ORG } as never;
    await expect(svc.send(OWNER_ORG, 999, actor)).rejects.toThrow(NotFoundException);
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeSweepsService — cross-tenant isolation", () => {
  it("sendManualReminder: envelope lookup scoped to attacker orgId (deny — cross-tenant isolation)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignEnvelopeSweepsService(
      db,
      mockAudit as never,
      mockTokens as never,
      mockNotifications as never,
      mockRecipients as never,
      mockIntegrations as never,
    );
    const actor = { userId: "attacker", orgId: ATTACKER_ORG } as never;
    await expect(svc.sendManualReminder(ATTACKER_ORG, 999, actor)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("sendManualReminder: uses own org in envelope lookup (control — same-tenant)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new SignEnvelopeSweepsService(
      db,
      mockAudit as never,
      mockTokens as never,
      mockNotifications as never,
      mockRecipients as never,
      mockIntegrations as never,
    );
    const actor = { userId: "owner", orgId: OWNER_ORG } as never;
    await expect(svc.sendManualReminder(OWNER_ORG, 999, actor)).rejects.toThrow(NotFoundException);
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});
