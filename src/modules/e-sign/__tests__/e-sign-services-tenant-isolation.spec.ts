import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
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

function makeDb(rows: unknown[] = []): { db: Db; where: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock } {
  const where = jest.fn().mockResolvedValue(rows);
  const builder = {
    from: jest.fn(),
    where,
    limit: jest.fn().mockResolvedValue(rows),
    orderBy: jest.fn(),
    offset: jest.fn().mockResolvedValue(rows),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    groupBy: jest.fn(),
  };
  builder.from.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.groupBy.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockResolvedValue(rows);

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
    },
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, orgId: OWNER_ORG }]) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{}]) }) }) }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  } as unknown as Db;
  return { db, where, findMany, findFirst };
}

describe("SignSettingsService — cross-tenant isolation", () => {
  let svc: SignSettingsService;
  let findFirst: jest.Mock;
  let findMany: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findFirst = mocks.findFirst;
    findMany = mocks.findMany;
    const mockAudit = { record: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        SignSettingsService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignAuditService", useValue: mockAudit },
      ],
    }).compile();
    svc = mod.get(SignSettingsService);
  });

  it("getOrCreate: query scoped to attacker orgId (deny — different org isolation)", async () => {
    await svc.getOrCreate(ATTACKER_ORG);
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("getOrCreate: returns/creates settings for own org (control)", async () => {
    const result = await svc.getOrCreate(OWNER_ORG);
    expect(result).toBeDefined();
    void findMany;
  });
});

describe("SignTemplatesService — cross-tenant isolation", () => {
  let svc: SignTemplatesService;
  let findMany: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findMany = mocks.findMany;
    const mockAudit = { record: jest.fn() };
    const mockTokens = { createPublicToken: jest.fn() };
    const mockPlanLimits = { assertWithinLimit: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        SignTemplatesService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignAuditService", useValue: mockAudit },
        { provide: "SignTokensService", useValue: mockTokens },
        { provide: "PlanLimitsService", useValue: mockPlanLimits },
      ],
    }).compile();
    svc = mod.get(SignTemplatesService);
  });

  it("list: query scoped to attacker orgId (deny — different org isolation)", async () => {
    const result = await svc.list(ATTACKER_ORG);
    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const callArg = findMany.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("list: returns templates for own org (control)", async () => {
    const row = { id: 1, orgId: OWNER_ORG, name: "Template A", templateJson: "{}", status: "draft", createdAt: new Date(), updatedAt: new Date() };
    const mocks = makeDb([row]);
    mocks.findMany.mockResolvedValue([row]);
    const mockAudit = { record: jest.fn() };
    const mockTokens = { createPublicToken: jest.fn() };
    const mockPlanLimits = { assertWithinLimit: jest.fn() };
    const svc2 = await Test.createTestingModule({
      providers: [
        SignTemplatesService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignAuditService", useValue: mockAudit },
        { provide: "SignTokensService", useValue: mockTokens },
        { provide: "PlanLimitsService", useValue: mockPlanLimits },
      ],
    }).compile().then((m) => m.get(SignTemplatesService));
    const result = await svc2.list(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});

describe("SignReportsService — cross-tenant isolation", () => {
  let svc: SignReportsService;
  let where: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    where = mocks.where;
    const mockSettings = { getOrCreate: jest.fn().mockResolvedValue({ orgId: ATTACKER_ORG }) };
    const mod = await Test.createTestingModule({
      providers: [
        SignReportsService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignSettingsService", useValue: mockSettings },
      ],
    }).compile();
    svc = mod.get(SignReportsService);
  });

  it("getSummary: WHERE includes attacker orgId (deny — different org isolation)", async () => {
    await svc.getSummary(ATTACKER_ORG);
    expect(where).toHaveBeenCalled();
    const allVals = where.mock.calls.flatMap((call) => sqlValues(call[0]));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("getSummary: resolves without cross-tenant data for own org (control)", async () => {
    await expect(svc.getSummary(OWNER_ORG)).resolves.toBeDefined();
  });
});

describe("SignAiService — cross-tenant isolation", () => {
  let svc: SignAiService;
  let findFirst: jest.Mock;
  let findMany: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findFirst = mocks.findFirst;
    findMany = mocks.findMany;
    const mockStorage = { getFileStream: jest.fn() };
    const mockGateway = { chat: jest.fn().mockResolvedValue({ content: "summary" }) };
    const mod = await Test.createTestingModule({
      providers: [
        SignAiService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "StorageService", useValue: mockStorage },
        { provide: "AiGatewayService", useValue: mockGateway },
      ],
    }).compile();
    svc = mod.get(SignAiService);
  });

  it("summarizeDocument: envelope query scoped to attacker orgId (deny — different org isolation)", async () => {
    await expect(svc.summarizeDocument(ATTACKER_ORG, 999, "user-x")).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("summarizeDocument: uses own org in query (control — same tenant)", async () => {
    await expect(svc.summarizeDocument(OWNER_ORG, 999, "user-y")).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
    void findMany;
  });
});

describe("SignEnvelopeValidationService — cross-tenant isolation", () => {
  let svc: SignEnvelopeValidationService;
  let findFirst: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findFirst = mocks.findFirst;
    const mockRecipients = { listForEnvelope: jest.fn().mockResolvedValue([]) };
    const mod = await Test.createTestingModule({
      providers: [
        SignEnvelopeValidationService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignRecipientsService", useValue: mockRecipients },
      ],
    }).compile();
    svc = mod.get(SignEnvelopeValidationService);
  });

  it("validate: envelope query scoped to attacker orgId (deny — different org isolation)", async () => {
    await expect(svc.validate(ATTACKER_ORG, 999)).resolves.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("validate: resolves for own org (control — same tenant)", async () => {
    await expect(svc.validate(OWNER_ORG, 999)).resolves.toBeDefined();
  });
});

describe("SignBulkSendService — cross-tenant isolation", () => {
  let svc: SignBulkSendService;
  let findFirst: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findFirst = mocks.findFirst;
    const sharedMock = { record: jest.fn(), getOrCreate: jest.fn().mockResolvedValue({}), listForEnvelope: jest.fn().mockResolvedValue([]), createRecipient: jest.fn(), send: jest.fn(), createFromEnvelope: jest.fn(), create: jest.fn(), createPublicToken: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        SignBulkSendService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignAuditService", useValue: sharedMock },
        { provide: "SignSettingsService", useValue: sharedMock },
        { provide: "SignNotificationsService", useValue: sharedMock },
        { provide: "SignTemplatesService", useValue: sharedMock },
        { provide: "SignEnvelopesService", useValue: sharedMock },
        { provide: "SignIntegrationsService", useValue: sharedMock },
      ],
    }).compile();
    svc = mod.get(SignBulkSendService);
  });

  it("references attacker orgId in its template lookup (cross-tenant isolation)", async () => {
    await expect(svc.send(ATTACKER_ORG, 1, "user-x", { recipients: [] } as never)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("references own org in template lookup (control — same tenant)", async () => {
    await expect(svc.send(OWNER_ORG, 1, "user-y", { recipients: [] } as never)).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeDispatchService — cross-tenant isolation", () => {
  let svc: SignEnvelopeDispatchService;
  let findFirst: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findFirst = mocks.findFirst;
    const sharedMock = { record: jest.fn(), getOrCreate: jest.fn().mockResolvedValue({}), listForEnvelope: jest.fn().mockResolvedValue([]), createRecipient: jest.fn(), createPublicToken: jest.fn(), send: jest.fn() };
    const mockValidation = { validate: jest.fn().mockResolvedValue({ isValid: true, errors: [] }) };
    const mod = await Test.createTestingModule({
      providers: [
        SignEnvelopeDispatchService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignAuditService", useValue: sharedMock },
        { provide: "SignTokensService", useValue: sharedMock },
        { provide: "SignSettingsService", useValue: sharedMock },
        { provide: "SignNotificationsService", useValue: sharedMock },
        { provide: "SignRecipientsService", useValue: sharedMock },
        { provide: "SignIntegrationsService", useValue: sharedMock },
        { provide: "SignEnvelopeValidationService", useValue: mockValidation },
        { provide: "SignEnvelopeSweepsService", useValue: sharedMock },
      ],
    }).compile();
    svc = mod.get(SignEnvelopeDispatchService);
  });

  it("send: envelope lookup scoped to attacker orgId (deny — cross-tenant isolation)", async () => {
    const actor = { userId: "attacker", orgId: ATTACKER_ORG } as never;
    await expect(svc.send(ATTACKER_ORG, 999, actor)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("send: envelope lookup scoped to own org (control — same tenant)", async () => {
    const actor = { userId: "owner", orgId: OWNER_ORG } as never;
    await expect(svc.send(OWNER_ORG, 999, actor)).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});

describe("SignEnvelopeSweepsService — cross-tenant isolation", () => {
  let svc: SignEnvelopeSweepsService;
  let findFirst: jest.Mock;

  beforeEach(async () => {
    const mocks = makeDb([]);
    findFirst = mocks.findFirst;
    const sharedMock = { record: jest.fn(), createPublicToken: jest.fn(), send: jest.fn(), sendReminder: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        SignEnvelopeSweepsService,
        { provide: DRIZZLE, useValue: mocks.db },
        { provide: "SignAuditService", useValue: sharedMock },
        { provide: "SignTokensService", useValue: sharedMock },
        { provide: "SignNotificationsService", useValue: sharedMock },
        { provide: "SignRecipientsService", useValue: { listForEnvelope: jest.fn().mockResolvedValue([]) } },
        { provide: "SignIntegrationsService", useValue: sharedMock },
      ],
    }).compile();
    svc = mod.get(SignEnvelopeSweepsService);
  });

  it("expireEnvelope: envelope lookup scoped to attacker orgId (deny — cross-tenant isolation)", async () => {
    await expect(svc.expireEnvelope(ATTACKER_ORG, 999)).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("expireEnvelope: uses own org in envelope lookup (control — same tenant)", async () => {
    await expect(svc.expireEnvelope(OWNER_ORG, 999)).rejects.toBeDefined();
    const callArg = findFirst.mock.calls[0]?.[0];
    const vals = sqlValues(callArg?.where);
    expect(vals).toContain(OWNER_ORG);
  });
});
