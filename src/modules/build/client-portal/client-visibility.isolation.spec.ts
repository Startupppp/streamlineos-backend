import { NotFoundException } from "@nestjs/common";
import { ClientVisibilityService } from "./client-visibility.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ClientVisibilityService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when project belongs to a different org", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        tickets: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;

    const svc = new ClientVisibilityService(db, mockAudit);

    await expect(svc.getVisibilitySummary("org-attacker", 99)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when toggling ticket visibility on a different org's project", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;

    const svc = new ClientVisibilityService(db, mockAudit);

    await expect(
      svc.toggleTicketVisibility("org-attacker", "user-1", 1, 99, true),
    ).rejects.toThrow(NotFoundException);
  });
});
