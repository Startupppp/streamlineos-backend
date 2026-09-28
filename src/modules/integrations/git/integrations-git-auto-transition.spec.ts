/**
 * Bite proof for I2: autoTransitionOnMerge must open its own runInNewTenantTransaction.
 *
 * Without the fix, autoTransitionOnMerge queried this.db directly after the outer
 * tenant transaction committed, causing 42501 (GUC gone). The fix wraps all queries
 * in runInNewTenantTransaction so each run carries its own GUC.
 *
 * Bite proof: mock runInNewTenantTransaction to be a spy; verify it is called with
 * the correct orgId. Without the wrapper, the spy call count stays 0 and the test fails.
 */
import * as tenantTx from "../../../common/tenant/run-in-tenant-transaction";
import { IntegrationsGitService } from "./integrations-git.service";
import type { Db } from "../../../db/drizzle.module";
import type { ProjectsTicketsUpdateService } from "../../build/core/tickets";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => {
  const actual = jest.requireActual<typeof import("../../../common/tenant/run-in-tenant-transaction")>(
    "../../../common/tenant/run-in-tenant-transaction",
  );
  return {
    ...actual,
    runInNewTenantTransaction: jest.fn(),
    runInTenantTransaction: jest.fn(),
  };
});

const mockRunInNewTenantTransaction = tenantTx.runInNewTenantTransaction as jest.Mock;
const mockRunInTenantTransaction = tenantTx.runInTenantTransaction as jest.Mock;

const ORG = "org-abc";

function makeDb(): Db {
  return {
    query: {},
    execute: jest.fn(),
    insert: jest.fn(),
    select: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

function makeTicketsService(): ProjectsTicketsUpdateService {
  return { updateTicket: jest.fn().mockResolvedValue(undefined) } as unknown as ProjectsTicketsUpdateService;
}

describe("IntegrationsGitService — autoTransitionOnMerge tenant isolation (I2)", () => {
  let svc: IntegrationsGitService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunInNewTenantTransaction.mockResolvedValue(undefined);
    mockRunInTenantTransaction.mockResolvedValue(undefined);
    svc = new IntegrationsGitService(makeDb(), makeTicketsService());
  });

  it("opens runInNewTenantTransaction for DB queries (prevents 42501 post-commit)", async () => {
    const mergedLinks = [
      {
        orgId: ORG,
        ticketId: 1,
        connectionId: 1,
        provider: "github" as const,
        refType: "pull_request" as const,
        externalId: "pr-42",
        status: "merged",
      },
    ];

    await (svc as unknown as {
      autoTransitionOnMerge: (orgId: string, links: typeof mergedLinks) => Promise<void>;
    }).autoTransitionOnMerge(ORG, mergedLinks);

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledTimes(1);
    expect(mockRunInNewTenantTransaction).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      expect.any(Function),
    );
  });

  it("bites: skips runInNewTenantTransaction when ticketIds is empty — no transaction needed", async () => {
    await (svc as unknown as {
      autoTransitionOnMerge: (orgId: string, links: []) => Promise<void>;
    }).autoTransitionOnMerge(ORG, []);

    expect(mockRunInNewTenantTransaction).not.toHaveBeenCalled();
  });
});
