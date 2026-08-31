import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import { CrmConnectorLifecycleService } from "./crm-connector-lifecycle.service";

describe("CrmConnectorLifecycleService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const SYNC_ID = "sync-uuid-1";

  function makeDb(syncRow: unknown): Db {
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
    const mockWorkflows = {} as any;
    const svc = new CrmConnectorLifecycleService(db, mockWorkflows);
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
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([syncRow]) }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ count: 0 }]),
          }),
        };
      }),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const mockWorkflows = {} as any;
    const svc = new CrmConnectorLifecycleService(db, mockWorkflows);
    const result = await svc.progress(OWNER, SYNC_ID);
    expect(result.crmConnectorSyncId).toBe(SYNC_ID);
  });
});
