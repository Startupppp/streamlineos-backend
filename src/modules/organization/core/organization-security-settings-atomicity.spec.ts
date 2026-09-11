import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { MfaPolicyService } from "../../access/mfa-policy.service";
import { OrganizationSettingsService } from "./organization-settings.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

const runInTenantTransactionMock = runInTenantTransaction as unknown as jest.Mock;

const ORG_ID = "org-1";
const ACTOR = "user-1";

interface Recorded {
  writes: string[];
  txHandles: unknown[];
  cacheSets: string[];
  orderVersusCache: string[];
}

function makeService(recorded: Recorded, failDomainWrite = false) {
  const makeTx = () => {
    const tx = {
      update: () => ({
        set: () => ({
          where: () => {
            recorded.writes.push("organizations");
            recorded.txHandles.push(tx);
            recorded.orderVersusCache.push("db");
            return Promise.resolve([]);
          },
        }),
      }),
      delete: () => ({
        where: () => {
          if (failDomainWrite) return Promise.reject(new Error("domain write failed"));
          recorded.writes.push("domains:delete");
          recorded.txHandles.push(tx);
          recorded.orderVersusCache.push("db");
          return Promise.resolve([]);
        },
      }),
      insert: () => ({
        values: () => {
          recorded.writes.push("domains:insert");
          recorded.txHandles.push(tx);
          return Promise.resolve([]);
        },
      }),
    };
    return tx;
  };

  runInTenantTransactionMock.mockImplementation(
    async (_db: unknown, work: (tx: unknown) => Promise<unknown>) => work(makeTx()),
  );

  const db = {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ settings: {} }),
      },
    },
  } as unknown as Db;

  const audit = { log: jest.fn() } as unknown as AuditService;
  const cache = {
    set: jest.fn(() => {
      recorded.cacheSets.push("org:ip-allowlist");
      recorded.orderVersusCache.push("cache");
      return Promise.resolve(undefined);
    }),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
  const mfaPolicy = {
    invalidateOrg: jest.fn().mockResolvedValue(undefined),
  } as unknown as MfaPolicyService;

  return new OrganizationSettingsService(db, audit, cache, mfaPolicy);
}

function newRecorded(): Recorded {
  return { writes: [], txHandles: [], cacheSets: [], orderVersusCache: [] };
}

describe("updateSecuritySettings — one transaction, cache after commit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes the organization row and the allowed domains through the same transaction handle", async () => {
    const recorded = newRecorded();
    const service = makeService(recorded);

    await service.updateSecuritySettings(ORG_ID, ACTOR, {
      mfaEnforced: true,
      allowedEmailDomains: ["example.com"],
    });

    expect(recorded.writes).toEqual([
      "organizations",
      "domains:delete",
      "domains:insert",
    ]);
    expect(runInTenantTransactionMock).toHaveBeenCalledTimes(1);
    expect(runInTenantTransactionMock.mock.calls[0][2]).toEqual({ orgId: ORG_ID });
    expect(new Set(recorded.txHandles).size).toBe(1);
  });

  it("leaves the IP-allowlist cache untouched when the transaction fails", async () => {
    const recorded = newRecorded();
    const service = makeService(recorded, true);

    await expect(
      service.updateSecuritySettings(ORG_ID, ACTOR, {
        mfaEnforced: true,
        allowedEmailDomains: ["example.com"],
        ipAllowlist: ["10.0.0.1"],
      }),
    ).rejects.toThrow("domain write failed");

    expect(recorded.cacheSets).toEqual([]);
  });

  it("writes the IP-allowlist cache only after the database transaction", async () => {
    const recorded = newRecorded();
    const service = makeService(recorded);

    await service.updateSecuritySettings(ORG_ID, ACTOR, {
      ipAllowlist: ["10.0.0.1"],
    });

    expect(recorded.orderVersusCache).toEqual(["db", "cache"]);
  });
});
