import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import { CrmConnectorService } from "./crm-connector.service";

describe("CrmConnectorService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const SYNC_ID = "sync-uuid-1";

  function makeDb(syncRow: unknown): Db {
    const chainable = { where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) };
    const select = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(chainable) });
    const selectReturning = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(syncRow ? [syncRow] : []) }),
      }),
    });
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(syncRow ? [syncRow] : []) }),
        }),
      })),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
  }

  it("throws NotFoundException for a sync belonging to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockComposio = {} as any;
    const mockImports = {} as any;
    const mockWorkflows = {} as any;
    const svc = new CrmConnectorService(db, mockComposio, mockImports, mockWorkflows);
    await expect(svc.progress(ATTACKER, SYNC_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns progress for a sync belonging to the owning org (control — same-tenant)", async () => {
    const syncRow = {
      crmConnectorSyncId: SYNC_ID,
      organizationId: OWNER,
      provider: "hubspot",
      stream: "contacts",
      enabled: true,
      syncedThrough: null,
      cursor: null,
      crmImportId: null,
      workflowRunId: null,
      lastRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
    };
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([syncRow]) }),
        }),
      })),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const mockComposio = {} as any;
    const mockImports = {} as any;
    const mockWorkflows = {} as any;
    const svc = new CrmConnectorService(db, mockComposio, mockImports, mockWorkflows);
    const result = await svc.progress(OWNER, SYNC_ID);
    expect(result.crmConnectorSyncId).toBe(SYNC_ID);
  });
});
