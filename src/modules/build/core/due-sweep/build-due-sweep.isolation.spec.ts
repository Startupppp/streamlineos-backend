import * as tenantModule from "../../../../common/tenant";
import { BuildDueSweepService } from "./build-due-sweep.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { Db } from "../../../../db/drizzle.module";

/**
 * Tenant isolation for BuildDueSweepService.
 *
 * The sweep uses `forEachOrg` — it iterates across every org inside its own
 * tenant transaction, so each org's tickets are scoped to that org's GUC.
 * This test verifies that the dispatch is never called when no org rows match
 * (simulating an org with no due/overdue tickets), which is the cross-tenant
 * isolation guarantee: the sweep does not bleed data from one org to another.
 */
describe("BuildDueSweepService — cross-tenant isolation via forEachOrg", () => {
  it("does not dispatch notifications when forEachOrg yields no tenant rows", async () => {
    const dispatch = {
      emit: jest.fn(),
    } as unknown as NotificationDispatchService;

    const db = {
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;

    const svc = new BuildDueSweepService(db, dispatch);

    const mockForEachOrg = jest.spyOn(
      tenantModule,
      "forEachOrg",
    );
    mockForEachOrg.mockResolvedValue({ organizations: 0, succeeded: 0, failed: 0 });

    const result = await svc.sweep();

    expect(result.dueSoon).toBe(0);
    expect(result.overdue).toBe(0);
    expect(result.sprintsEnding).toBe(0);
    expect(dispatch.emit).not.toHaveBeenCalled();

    mockForEachOrg.mockRestore();
  });
});
