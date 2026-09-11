jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));
jest.mock("../../../storage/storage-key-catalog", () => ({
  enumerateFileKeyColumns: jest.fn(),
  collectOrgFileKeys: jest.fn(),
}));

import { PURGE_ADAPTER_REGISTRY } from "./organization-purge-adapters";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { collectOrgFileKeys, enumerateFileKeyColumns } from "../../../storage/storage-key-catalog";

const ORG_A = "org-aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "org-bbbbbbbb-0000-0000-0000-000000000002";
const PURGE_JOB = "purge-job-00000000";

type MockTx = {
  delete?: jest.Mock;
  select?: jest.Mock;
};

function makeDeleteTx(): MockTx {
  const mockWhere = jest.fn().mockResolvedValue(undefined);
  return { delete: jest.fn().mockReturnValue({ where: mockWhere }) };
}

function makeCountTx(remaining: number): MockTx {
  const mockWhere = jest.fn().mockResolvedValue([{ remaining }]);
  const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
  return { select: jest.fn().mockReturnValue({ from: mockFrom }) };
}

function stubRunInTenant(deleteTx: MockTx, countTx: MockTx): void {
  (runInNewTenantTransaction as jest.Mock)
    .mockImplementationOnce(
      (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(deleteTx),
    )
    .mockImplementationOnce(
      (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(countTx),
    );
}

const FAKE_DB = {} as never;

describe("PURGE_ADAPTER_REGISTRY — static adapters", () => {
  it("cache → NOT_APPLICABLE", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.cache.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("NOT_APPLICABLE");
  });

  it("audit_evidence → NOT_APPLICABLE", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.audit_evidence.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("NOT_APPLICABLE");
  });

  it("search_index → NOT_APPLICABLE (no external search client; Postgres-side only)", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.search_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("NOT_APPLICABLE");
  });

  it("object_storage → FAILED when no storage service is provided", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.object_storage.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("FAILED");
    expect(result.detail).toMatch(/storage service not available/i);
  });

  it("analytics_copies → FAILED", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.analytics_copies.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("FAILED");
  });

  it("provider_mirrors → FAILED with Composio explanation", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.provider_mirrors.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("FAILED");
    expect(result.detail).toMatch(/composio/i);
  });

  it("backups → FAILED", async () => {
    const result = await PURGE_ADAPTER_REGISTRY.backups.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(result.state).toBe("FAILED");
  });
});

describe("PURGE_ADAPTER_REGISTRY — object_storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fails when purge bookkeeping cannot be recorded even if no keys remain", async () => {
    (enumerateFileKeyColumns as jest.Mock).mockResolvedValue([]);
    (collectOrgFileKeys as jest.Mock)
      .mockResolvedValueOnce([{ key: "documents/example.pdf", bucket: "default" }])
      .mockResolvedValueOnce([]);
    (runInNewTenantTransaction as jest.Mock).mockRejectedValueOnce(new Error("RLS denied"));

    const deleteFile = jest.fn();
    const result = await PURGE_ADAPTER_REGISTRY.object_storage.confirm(ORG_A, PURGE_JOB, FAKE_DB, {
      port: { deleteFile },
      kbBucket: "kb-files",
    });

    expect(result.state).toBe("FAILED");
    // The guarantee is that a failed bookkeeping write stops the purge before
    // anything is deleted, and says why. Ticket 21 moved the pending-row write
    // from one transaction per key to one bulk upsert for the whole set, so the
    // failure is now reported at registration rather than per key — the two
    // behavioural assertions either side of this are the contract.
    expect(result.detail).toMatch(/failed to register|failed keys/i);
    expect(result.detail).toMatch(/RLS denied/);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe("PURGE_ADAPTER_REGISTRY — database_rows", () => {
  function makeMockDb(orgRow: unknown) {
    const limitMock = jest.fn().mockResolvedValue(orgRow === null ? [] : [orgRow]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const fromMock = jest.fn().mockReturnValue({ where: whereMock });
    return { select: jest.fn().mockReturnValue({ from: fromMock }) };
  }

  it("confirms an eligible scheduled organization for the final physical-delete pass", async () => {
    const db = makeMockDb({ id: ORG_A, statusV2: "PURGE_SCHEDULED" }) as never;
    const result = await PURGE_ADAPTER_REGISTRY.database_rows.confirm(ORG_A, PURGE_JOB, db);
    expect(result.state).toBe("CONFIRMED");
    expect(result.detail).toMatch(/physically deletes/i);
  });

  it("returns CONFIRMED when org row is absent", async () => {
    const db = makeMockDb(null) as never;
    const result = await PURGE_ADAPTER_REGISTRY.database_rows.confirm(ORG_A, PURGE_JOB, db);
    expect(result.state).toBe("CONFIRMED");
    expect(result.detail).toMatch(/absent/i);
  });

  it("returns FAILED for an organization outside the purge state", async () => {
    const db = makeMockDb({ id: ORG_A, statusV2: "ACTIVE" }) as never;
    const result = await PURGE_ADAPTER_REGISTRY.database_rows.confirm(ORG_A, PURGE_JOB, db);
    expect(result.state).toBe("FAILED");
  });

  it("returns CONFIRMED when org row statusV2 is PURGED", async () => {
    const db = makeMockDb({ id: ORG_A, statusV2: "PURGED" }) as never;
    const result = await PURGE_ADAPTER_REGISTRY.database_rows.confirm(ORG_A, PURGE_JOB, db);
    expect(result.state).toBe("CONFIRMED");
  });
});

describe("PURGE_ADAPTER_REGISTRY — vector_index", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns CONFIRMED when post-delete verification shows zero remaining rows", async () => {
    stubRunInTenant(makeDeleteTx(), makeCountTx(0));

    const result = await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);

    expect(result.state).toBe("CONFIRMED");
    expect(result.detail).toMatch(/deleted and verified absent/i);
  });

  it("returns FAILED when delete succeeds but verification still finds rows — proving the re-check gates CONFIRMED", async () => {
    stubRunInTenant(makeDeleteTx(), makeCountTx(3));

    const result = await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);

    expect(result.state).toBe("FAILED");
    expect(result.detail).toMatch(/3 kb_article_chunk row/);

    (runInNewTenantTransaction as jest.Mock).mockClear();
    stubRunInTenant(makeDeleteTx(), makeCountTx(0));
    const confirmed = await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    expect(confirmed.state).toBe("CONFIRMED");
  });

  it("returns FAILED and does not throw when the delete call throws", async () => {
    (runInNewTenantTransaction as jest.Mock).mockRejectedValueOnce(
      new Error("RLS 42501: no tenant GUC"),
    );

    const result = await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);

    expect(result.state).toBe("FAILED");
    expect(result.detail).toMatch(/vector_index purge error/i);
    expect(result.detail).toContain("42501");
  });

  it("returns FAILED and does not throw when the count call throws", async () => {
    (runInNewTenantTransaction as jest.Mock)
      .mockImplementationOnce(
        (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
          fn(makeDeleteTx()),
      )
      .mockRejectedValueOnce(new Error("count query failed"));

    const result = await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);

    expect(result.state).toBe("FAILED");
    expect(result.detail).toMatch(/vector_index purge error/i);
  });

  it("org-scoping: runInNewTenantTransaction is called with ORG_A's id, not ORG_B's", async () => {
    stubRunInTenant(makeDeleteTx(), makeCountTx(0));

    await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);

    const calls = (runInNewTenantTransaction as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]?.[1]).toBe(ORG_A);
    expect(calls[1]?.[1]).toBe(ORG_A);
    expect(calls[0]?.[1]).not.toBe(ORG_B);
    expect(calls[1]?.[1]).not.toBe(ORG_B);
  });

  it("org-scoping: separate adapter calls each pass their own orgId independently", async () => {
    stubRunInTenant(makeDeleteTx(), makeCountTx(0));
    await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);
    const callsA = (runInNewTenantTransaction as jest.Mock).mock.calls.map((c) => c[1] as string);
    expect(callsA).toEqual([ORG_A, ORG_A]);

    (runInNewTenantTransaction as jest.Mock).mockClear();
    stubRunInTenant(makeDeleteTx(), makeCountTx(0));
    await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_B, PURGE_JOB, FAKE_DB);
    const callsB = (runInNewTenantTransaction as jest.Mock).mock.calls.map((c) => c[1] as string);
    expect(callsB).toEqual([ORG_B, ORG_B]);
  });

  it("invokes the delete callback — proves the transaction mock is not a bare no-op", async () => {
    const deleteTx = makeDeleteTx();
    stubRunInTenant(deleteTx, makeCountTx(0));

    await PURGE_ADAPTER_REGISTRY.vector_index.confirm(ORG_A, PURGE_JOB, FAKE_DB);

    expect(deleteTx.delete).toHaveBeenCalledTimes(1);
  });
});
