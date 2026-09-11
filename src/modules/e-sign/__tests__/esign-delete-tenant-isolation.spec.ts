jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockResolvedValue(undefined),
  runInTenantTransaction: jest.fn().mockResolvedValue(undefined),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SignDocumentsService } from "../sign-documents.service";
import { SignFieldsService } from "../sign-fields.service";
import { SignRecipientsService } from "../sign-recipients.service";
import { SignWatermarkService } from "../sign-watermark.service";

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

beforeEach(() => jest.resetAllMocks());

function makeDeleteCapturer() {
  let capturedWhere: unknown;
  const where = jest.fn().mockImplementation((predicate: unknown) => {
    capturedWhere = predicate;
    return Promise.resolve([]);
  });
  const deleteChain = jest.fn().mockReturnValue({ where });
  return { deleteChain, where, getWhere: () => capturedWhere };
}

function makeFindFirstChain(row: unknown | null) {
  return jest.fn().mockResolvedValue(row);
}

describe("SignDocumentsService.delete — orgId present in DELETE WHERE clause", () => {
  function makeDb(docRow: unknown | null) {
    const { deleteChain, getWhere } = makeDeleteCapturer();
    const findFirst = makeFindFirstChain(docRow);
    const db = {
      query: {
        signDocuments: { findFirst },
        signEnvelopes: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, status: "draft" }) },
      },
      delete: deleteChain,
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        }),
      }),
    } as unknown as Db;
    const mockStorage = { deleteFile: jest.fn().mockResolvedValue(undefined) } as never;
    const mockPdf = {} as never;
    const mockSettings = { getOrCreate: jest.fn() } as never;
    const mockAudit = { record: jest.fn() } as never;
    return { db, getWhere, mockStorage, mockPdf, mockSettings, mockAudit };
  }

  it("DENY — deleting a document from ATTACKER_ORG returns NotFoundException when document does not belong to that org", async () => {
    const { db, mockStorage, mockPdf, mockSettings, mockAudit } = makeDb(null);
    const svc = new SignDocumentsService(db, mockStorage, mockPdf, mockSettings, mockAudit);

    await expect(svc.delete(ATTACKER_ORG, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL — DELETE WHERE clause includes orgId for same-tenant document", async () => {
    const doc = { id: 42, orgId: OWNER_ORG, envelopeId: 1, currentFileKey: "esign/doc.pdf", originalFileKey: "esign/doc.pdf" };
    const { db, getWhere, mockStorage, mockPdf, mockSettings, mockAudit } = makeDb(doc);
    const svc = new SignDocumentsService(db, mockStorage, mockPdf, mockSettings, mockAudit);

    await svc.delete(OWNER_ORG, 42);

    const whereValues = sqlValues(getWhere());
    expect(whereValues).toContain(OWNER_ORG);
    expect(whereValues).toContain(42);
  });
});

describe("SignFieldsService.remove — orgId present in DELETE WHERE clause", () => {
  function makeDb(fieldRow: unknown | null) {
    const { deleteChain, getWhere } = makeDeleteCapturer();
    const findFirst = makeFindFirstChain(fieldRow);
    const db = {
      query: {
        signFields: { findFirst },
        signEnvelopes: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, status: "draft" }) },
      },
      delete: deleteChain,
    } as unknown as Db;
    const mockAudit = { record: jest.fn() } as never;
    const actor = { orgId: OWNER_ORG, userId: "user-1", ipAddress: "127.0.0.1", userAgent: "test" };
    return { db, getWhere, mockAudit, actor };
  }

  it("DENY — deleting a field from ATTACKER_ORG throws NotFoundException when field not found", async () => {
    const { db, mockAudit, actor } = makeDb(null);
    const svc = new SignFieldsService(db, mockAudit);

    await expect(svc.remove(ATTACKER_ORG, 99, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL — DELETE WHERE clause includes orgId for same-tenant field", async () => {
    const field = { id: 99, orgId: OWNER_ORG, envelopeId: 1, recipientId: 5, fieldType: "text" };
    const { db, getWhere, mockAudit, actor } = makeDb(field);
    const svc = new SignFieldsService(db, mockAudit);

    await svc.remove(OWNER_ORG, 99, actor);

    const whereValues = sqlValues(getWhere());
    expect(whereValues).toContain(OWNER_ORG);
    expect(whereValues).toContain(99);
  });
});

describe("SignRecipientsService.remove — orgId present in DELETE WHERE clause", () => {
  function makeDb(recipientRow: unknown | null) {
    const { deleteChain, getWhere } = makeDeleteCapturer();
    const findFirst = makeFindFirstChain(recipientRow);
    const db = {
      query: {
        signRecipients: { findFirst },
        signEnvelopes: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, status: "draft" }) },
      },
      delete: deleteChain,
    } as unknown as Db;
    const mockAudit = { record: jest.fn() } as never;
    const mockTokens = { hash: jest.fn() } as never;
    const actor = { orgId: OWNER_ORG, userId: "user-1", ipAddress: "127.0.0.1", userAgent: "test" };
    return { db, getWhere, mockAudit, mockTokens, actor };
  }

  it("DENY — deleting a recipient from ATTACKER_ORG throws NotFoundException when recipient not found", async () => {
    const { db, mockAudit, mockTokens, actor } = makeDb(null);
    const svc = new SignRecipientsService(db, mockAudit, mockTokens, {} as any);

    await expect(svc.remove(ATTACKER_ORG, 77, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL — DELETE WHERE clause includes orgId for same-tenant recipient", async () => {
    const recipient = { id: 77, orgId: OWNER_ORG, envelopeId: 1, name: "Alice", email: "a@b.com", status: "pending" };
    const { db, getWhere, mockAudit, mockTokens, actor } = makeDb(recipient);
    const svc = new SignRecipientsService(db, mockAudit, mockTokens, {} as any);

    await svc.remove(OWNER_ORG, 77, actor);

    const whereValues = sqlValues(getWhere());
    expect(whereValues).toContain(OWNER_ORG);
    expect(whereValues).toContain(77);
  });
});

describe("SignWatermarkService.remove — orgId present in DELETE WHERE clause", () => {
  function makeDb(policyRow: unknown | null) {
    const { deleteChain, getWhere } = makeDeleteCapturer();
    const findFirst = makeFindFirstChain(policyRow);
    const db = {
      query: {
        signWatermarkPolicies: { findFirst },
      },
      delete: deleteChain,
    } as unknown as Db;
    const mockAudit = { record: jest.fn() } as never;
    return { db, getWhere, mockAudit };
  }

  it("DENY — deleting a watermark policy from ATTACKER_ORG throws NotFoundException when policy not found", async () => {
    const { db, mockAudit } = makeDb(null);
    const svc = new SignWatermarkService(db, mockAudit);

    await expect(svc.remove(ATTACKER_ORG, 11, "user-x")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL — DELETE WHERE clause includes orgId for same-tenant watermark policy", async () => {
    const policy = { id: 11, orgId: OWNER_ORG };
    const { db, getWhere, mockAudit } = makeDb(policy);
    const svc = new SignWatermarkService(db, mockAudit);

    await svc.remove(OWNER_ORG, 11, "user-1");

    const whereValues = sqlValues(getWhere());
    expect(whereValues).toContain(OWNER_ORG);
    expect(whereValues).toContain(11);
  });
});

describe("SignWatermarkService.update — orgId present in UPDATE WHERE clause", () => {
  function makeUpdateDb(policyRow: unknown | null) {
    let capturedWhere: unknown;
    const returning = jest.fn().mockResolvedValue([policyRow ?? {}]);
    const where = jest.fn().mockImplementation((predicate: unknown) => {
      capturedWhere = predicate;
      return { returning };
    });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const findFirst = makeFindFirstChain(policyRow);
    const db = {
      query: {
        signWatermarkPolicies: { findFirst },
      },
      update,
    } as unknown as Db;
    const mockAudit = { record: jest.fn() } as never;
    return { db, getWhere: () => capturedWhere, mockAudit };
  }

  it("DENY — updating a watermark policy from ATTACKER_ORG throws NotFoundException when policy not found", async () => {
    const { db, mockAudit } = makeUpdateDb(null);
    const svc = new SignWatermarkService(db, mockAudit);

    await expect(svc.update(ATTACKER_ORG, 11, "user-x", { enabled: false })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL — UPDATE WHERE clause includes orgId for same-tenant watermark policy", async () => {
    const policy = { id: 11, orgId: OWNER_ORG };
    const { db, getWhere, mockAudit } = makeUpdateDb(policy);
    const svc = new SignWatermarkService(db, mockAudit);

    await svc.update(OWNER_ORG, 11, "user-1", { enabled: false });

    const whereValues = sqlValues(getWhere());
    expect(whereValues).toContain(OWNER_ORG);
    expect(whereValues).toContain(11);
  });
});
