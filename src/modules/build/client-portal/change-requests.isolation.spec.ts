import { NotFoundException } from "@nestjs/common";
import { ChangeRequestsService } from "./change-requests.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

function makeMockDb(changeRequestRow: unknown = undefined): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      changeRequests: { findFirst: jest.fn().mockResolvedValue(changeRequestRow) },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ChangeRequestsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when change request belongs to a different org", async () => {
    const db = makeMockDb(undefined);
    const svc = new ChangeRequestsService(db, mockAudit);

    await expect(svc.getChangeRequest("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns the change request when orgId matches", async () => {
    const crRow = {
      id: 1,
      orgId: "org-1",
      projectId: 1,
      crNumber: 1,
      title: "Add feature",
      status: "PENDING",
      deletedAt: null,
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        changeRequests: { findFirst: jest.fn().mockResolvedValue(crRow) },
      },
      select: jest.fn(),
      transaction: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;

    const svc = new ChangeRequestsService(db, mockAudit);
    const result = await svc.getChangeRequest("org-1", 1, 1);
    expect(result).toEqual(crRow);
  });

  it("throws NotFoundException for project lookup with wrong org before listing change requests", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        changeRequests: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new ChangeRequestsService(db, mockAudit);

    await expect(
      svc.listChangeRequests("org-attacker", 1, {}),
    ).rejects.toThrow(NotFoundException);
  });
});
