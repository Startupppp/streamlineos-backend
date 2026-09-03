import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";

const TICKET = {
  ticketId: 10,
  projectId: 1,
  orgId: "org-1",
  status: "TODO",
  priority: "MEDIUM",
  assigneeId: null,
  title: "Fix bug",
  type: "TASK",
};

const RULE = {
  id: 1,
  conditions: [],
  actions: [{ type: "set_status", value: "IN_PROGRESS" }],
  createdBy: "user-1",
};

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("BuildAutomationRunnerService — automations are deferred past the request commit", () => {
  let service: BuildAutomationRunnerService;

  const dbSelect = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([RULE]) };
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const mockDb = {
    select: jest.fn().mockReturnValue(dbSelect),
    update: jest.fn().mockReturnValue({ set: updateSet }),
    insert: jest.fn(),
    query: { ticketLabels: { findFirst: jest.fn().mockResolvedValue(null) } },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.select.mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([RULE]);
    mockDb.update.mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateWhere });
    updateWhere.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [BuildAutomationRunnerService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(BuildAutomationRunnerService);
  });

  /**
   * The defect: `void this.execute(...)` started the automation on the request's own
   * transaction and let it race the COMMIT. Whatever had not finished by then ran
   * against a committed handle with no tenant GUC and died 42501 — the rule silently
   * did not apply. The fix registers the work as an after-commit hook, which the
   * interceptor drains inside a fresh tenant transaction.
   */
  it("does not touch the database while the request transaction is still open", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const context: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: {} as TenantTx,
      afterCommit,
    };

    await runWithTenantContext(context, async () => {
      service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
      await flush();
    });

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
  });

  it("applies the rule once the registered hook is drained after the commit", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const context: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: {} as TenantTx,
      afterCommit,
    };

    await runWithTenantContext(context, async () => {
      service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
      await flush();
    });

    for (const hook of afterCommit) await hook();

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "IN_PROGRESS" }));
  });

  /**
   * Background sweeps run under `forEachOrg`, whose context carries no `afterCommit`
   * array, so `registerAfterCommit` returns false there. CLAUDE.md §4 requires the
   * work to run inline in that case rather than being dropped.
   */
  it("runs inline when there is no ambient context to defer into", async () => {
    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});
