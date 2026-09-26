jest.mock("../../../common/tenant", () => ({ forEachOrg: jest.fn() }));
jest.mock("../../kb/core/kb-chunk-retention", () => ({
  pruneStaleDocumentChunks: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { forEachOrg } from "../../../common/tenant";
import { pruneStaleDocumentChunks } from "../../kb/core/kb-chunk-retention";
import { CronKbChunkRetentionService } from "../cron-kb-chunk-retention.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;
const mockedPrune = pruneStaleDocumentChunks as jest.MockedFunction<
  typeof pruneStaleDocumentChunks
>;

const ORG_A = "org-chunk-aaaa";
const ORG_B = "org-chunk-bbbb";

async function buildSvc(): Promise<CronKbChunkRetentionService> {
  const mod = await Test.createTestingModule({
    providers: [
      CronKbChunkRetentionService,
      { provide: DRIZZLE, useValue: {} },
    ],
  }).compile();
  return mod.get(CronKbChunkRetentionService);
}

beforeEach(() => jest.resetAllMocks());

describe("CronKbChunkRetentionService — delegation to pruneStaleDocumentChunks", () => {
  it("calls pruneStaleDocumentChunks for each org with its scoped transaction (positive)", async () => {
    const tx = {};
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(tx as never, ORG_A);
      await fn(tx as never, ORG_B);
      return { organizations: 2, succeeded: 2, failed: 0 };
    });
    mockedPrune.mockResolvedValue(0);
    const svc = await buildSvc();

    await svc.pruneStaleChunks();

    expect(mockedPrune).toHaveBeenCalledWith(tx, ORG_A);
    expect(mockedPrune).toHaveBeenCalledWith(tx, ORG_B);
  });

  it("does not pass a different org's id to pruneStaleDocumentChunks (negative — cross-tenant isolation)", async () => {
    const tx = {};
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(tx as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });
    mockedPrune.mockResolvedValue(0);
    const svc = await buildSvc();

    await svc.pruneStaleChunks();

    expect(mockedPrune).not.toHaveBeenCalledWith(expect.anything(), ORG_B);
  });
});

describe("CronKbChunkRetentionService — result accumulation", () => {
  it("sums pruned chunk counts across all orgs and returns orgsProcessed (positive)", async () => {
    const tx = {};
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn(tx as never, ORG_A);
      await fn(tx as never, ORG_B);
      return { organizations: 2, succeeded: 2, failed: 0 };
    });
    mockedPrune.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    const svc = await buildSvc();

    const result = await svc.pruneStaleChunks();

    expect(result.pageChunksPruned).toBe(10);
    expect(result.orgsProcessed).toBe(2);
  });

  it("returns zero pageChunksPruned when all orgs have no stale chunks (negative — clean state)", async () => {
    mockedForEachOrg.mockImplementation(async (_db, _name, fn) => {
      await fn({} as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });
    mockedPrune.mockResolvedValue(0);
    const svc = await buildSvc();

    const result = await svc.pruneStaleChunks();

    expect(result.pageChunksPruned).toBe(0);
    expect(result.orgsProcessed).toBe(1);
  });
});
