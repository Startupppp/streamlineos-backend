import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ContactRolesService } from "./contact-roles.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";

const ORG_A = "org-a";
const ORG_B = "org-b";

function makeDb(overrides: Record<string, unknown> = {}) {
  const base = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(base);
    }),
    execute: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return base;
}

describe("ContactRolesService – mergeContacts", () => {
  let svc: ContactRolesService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactRolesService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(ContactRolesService);
  });

  it("throws NotFoundException when primary contact is not in the org", async () => {
    db.where.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(
      svc.mergeContacts(ORG_A, { primaryId: 1, duplicateId: 2 }, "user-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when duplicate contact is not in the org", async () => {
    const primaryRow = { id: 1, orgId: ORG_A, name: "Primary" };
    db.where
      .mockResolvedValueOnce([primaryRow])
      .mockResolvedValueOnce([]);

    await expect(
      svc.mergeContacts(ORG_A, { primaryId: 1, duplicateId: 2 }, "user-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("succeeds and returns primaryId + mergedId when both contacts belong to the same org", async () => {
    const primaryRow = { id: 1, orgId: ORG_A, name: "Primary", email: "p@ex.com", phone: null, title: null, company: null, department: null, avatarUrl: null, linkedinUrl: null, twitterUrl: null, organizationId: null };
    const dupRow = { id: 2, orgId: ORG_A, name: "Dup", email: null, phone: "+91999", title: "CEO", company: "ACME", department: null, avatarUrl: null, linkedinUrl: null, twitterUrl: null, organizationId: 5 };

    db.where
      .mockResolvedValueOnce([primaryRow])
      .mockResolvedValueOnce([dupRow]);

    db.update.mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) });

    const result = await svc.mergeContacts(ORG_A, { primaryId: 1, duplicateId: 2 }, "user-1");
    expect(result).toEqual({ success: true, primaryId: 1, mergedId: 2 });
  });
});

describe("ContactRolesService – cross-org denial", () => {
  let svc: ContactRolesService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactRolesService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(ContactRolesService);
  });

  it("throws ForbiddenException when primary belongs to a different org", async () => {
    const primaryRow = { id: 1, orgId: ORG_B, name: "Primary" };
    const dupRow = { id: 2, orgId: ORG_A, name: "Dup" };

    db.where
      .mockResolvedValueOnce([primaryRow])
      .mockResolvedValueOnce([dupRow]);

    await expect(
      svc.mergeContacts(ORG_A, { primaryId: 1, duplicateId: 2 }, "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
