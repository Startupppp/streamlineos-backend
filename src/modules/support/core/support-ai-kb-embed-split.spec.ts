import { GUARDS_METADATA } from "@nestjs/common/constants";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { PermissionGuard } from "../../access/permission.guard";
import { SupportAiController } from "./support-ai.controller";
import { SupportAiEmbeddingsHelper } from "./support-ai-embeddings.helper";
import { SupportAiTriageDataService } from "./support-ai-triage-data.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

const mockedRunInTenantTransaction = jest.mocked(runInTenantTransaction);

describe("support AI KB/embed transaction split", () => {
  let transactionDepth: number;

  beforeEach(() => {
    jest.clearAllMocks();
    transactionDepth = 0;
    mockedRunInTenantTransaction.mockImplementation(
      async (_db, callback) => {
        transactionDepth += 1;
        try {
          return await callback(_db as never);
        } finally {
          transactionDepth -= 1;
        }
      },
    );
  });

  it("keeps controller authentication and authorization guards in front of AI providers", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      SupportAiController,
    ) as unknown[];

    expect(guards).toEqual(
      expect.arrayContaining([JwtAuthGuard, PermissionGuard]),
    );
  });

  it("opts affected routes out of the request transaction and keeps invalid ids fail-closed", () => {
    const handlers = [
      SupportAiController.prototype.suggestReply,
      SupportAiController.prototype.generateHandoffSummary,
      SupportAiController.prototype.findRootCauseCluster,
    ];

    for (const handler of handlers) {
      expect(Reflect.getMetadata("no_tenant_transaction", handler)).toBe(true);
      const validation = Reflect.getMetadata("validation:schemas", handler) as {
        params: { safeParse(input: unknown): { success: boolean } };
      };
      expect(validation.params.safeParse({ ticketId: "0" }).success).toBe(
        false,
      );
    }
  });

  it("does not invoke KB embedding when the caller has no accessible spaces", async () => {
    const aiGateway = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest.fn(),
    };
    const kbAccess = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([]),
      getPrincipalIds: jest.fn(),
    };
    const service = new SupportAiTriageDataService(
      {} as never,
      aiGateway as never,
      {} as never,
      kbAccess as never,
    );

    await expect(
      service.searchKbForTicket(
        { orgId: "org-a" } as never,
        "printer is offline",
      ),
    ).resolves.toEqual([]);
    expect(kbAccess.getAccessibleSpaceIds).toHaveBeenCalledTimes(1);
    expect(aiGateway.embedQueryWithCredit).not.toHaveBeenCalled();
    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("releases the tenant transaction before KB embedding and opens a new one for vector search", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: (...args: unknown[]) => {
                expect(transactionDepth).toBe(1);
                return limit(...args);
              },
            })),
          })),
        })),
      })),
    };
    const aiGateway = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest.fn(async () => {
        expect(transactionDepth).toBe(0);
        return { ok: true, vectorLiteral: "[0.1,0.2]" };
      }),
    };
    const kbAccess = {
      getAccessibleSpaceIds: jest.fn(async () => {
        expect(transactionDepth).toBe(1);
        return [7];
      }),
      getPrincipalIds: jest.fn(async () => {
        expect(transactionDepth).toBe(1);
        return { membershipId: 11, roleSlugs: ["MEMBER"] };
      }),
    };
    const service = new SupportAiTriageDataService(
      db as never,
      aiGateway as never,
      {} as never,
      kbAccess as never,
    );

    await expect(
      service.searchKbForTicket(
        { orgId: "org-a" } as never,
        "printer is offline",
      ),
    ).resolves.toEqual([]);
    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not open a post-embed transaction when KB embedding fails", async () => {
    const aiGateway = {
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embedQueryWithCredit: jest
        .fn()
        .mockResolvedValue({ ok: false, kind: "provider_error" }),
    };
    const kbAccess = {
      getAccessibleSpaceIds: jest.fn().mockResolvedValue([7]),
      getPrincipalIds: jest
        .fn()
        .mockResolvedValue({ membershipId: 11, roleSlugs: [] }),
    };
    const service = new SupportAiTriageDataService(
      {} as never,
      aiGateway as never,
      {} as never,
      kbAccess as never,
    );

    await expect(
      service.searchKbForTicket(
        { orgId: "org-a" } as never,
        "printer is offline",
      ),
    ).resolves.toEqual([]);
    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("fails closed before embedding when the ticket is absent in the tenant", async () => {
    const db = {
      query: {
        supportTickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      insert: jest.fn(),
      select: jest.fn(),
    };
    const aiGateway = { embedQueryWithCredit: jest.fn() };
    const helper = new SupportAiEmbeddingsHelper(
      db as never,
      aiGateway as never,
    );

    await expect(
      helper.upsertAndSearchSimilar("org-a", 42, 5),
    ).rejects.toMatchObject({ status: 404 });
    expect(aiGateway.embedQueryWithCredit).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("releases the read transaction before ticket embedding and uses a new transaction for upsert/search", async () => {
    const vectorLimit = jest.fn().mockResolvedValue([]);
    const onConflictDoUpdate = jest.fn(async () => {
      expect(transactionDepth).toBe(1);
    });
    const db = {
      query: {
        supportTickets: {
          findFirst: jest.fn(async () => {
            expect(transactionDepth).toBe(1);
            return { title: "Printer offline", description: "Floor 2" };
          }),
        },
      },
      insert: jest.fn(() => ({
        values: jest.fn(() => ({ onConflictDoUpdate })),
      })),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({
                limit: (...args: unknown[]) => {
                  expect(transactionDepth).toBe(1);
                  return vectorLimit(...args);
                },
              })),
            })),
          })),
        })),
      })),
    };
    const aiGateway = {
      embedQueryWithCredit: jest.fn(async () => {
        expect(transactionDepth).toBe(0);
        return {
          ok: true,
          vector: [0.1, 0.2],
          vectorLiteral: "[0.1,0.2]",
        };
      }),
    };
    const helper = new SupportAiEmbeddingsHelper(
      db as never,
      aiGateway as never,
    );

    await expect(
      helper.upsertAndSearchSimilar("org-a", 42, 5),
    ).resolves.toEqual([]);
    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not open a write transaction when ticket embedding fails", async () => {
    const db = {
      query: {
        supportTickets: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ title: "Printer offline", description: null }),
        },
      },
      insert: jest.fn(),
    };
    const aiGateway = {
      embedQueryWithCredit: jest.fn().mockResolvedValue({
        ok: false,
        kind: "provider_error",
        message: "embedding unavailable",
      }),
    };
    const helper = new SupportAiEmbeddingsHelper(
      db as never,
      aiGateway as never,
    );

    await expect(
      helper.upsertAndSearchSimilar("org-a", 42, 5),
    ).rejects.toThrow("embedding unavailable");
    expect(mockedRunInTenantTransaction).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
