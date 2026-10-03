import type { Db } from "../../../db/drizzle.module";
import { GitConnectionsService } from "./git-connections.service";
import { IntegrationsGitService } from "./integrations-git.service";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { ProjectsTicketsUpdateService } from "../../build/core/tickets";
import type { WebhookRequest } from "./git.types";
import * as tenantTx from "../../../common/tenant/run-in-tenant-transaction";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => {
  const actual = jest.requireActual<typeof import("../../../common/tenant/run-in-tenant-transaction")>(
    "../../../common/tenant/run-in-tenant-transaction",
  );
  return {
    ...actual,
    runInTenantTransaction: jest.fn(),
    runInNewTenantTransaction: jest.fn(),
  };
});

const mockRunInTenantTransaction = tenantTx.runInTenantTransaction as jest.Mock;

const ORG = "org-abc";
const CONN_ID = 7;
const GOOD_SECRET = "s3cr3tABCD1234567890ABCD1234567890123456";
const BAD_SECRET = "wrongSecretValue0000000000000000000000";

function makeDb(): Db {
  return {
    execute: jest.fn().mockResolvedValue([{ org_id: ORG }]),
    query: {},
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  } as unknown as Db;
}

function makeTickets(): ProjectsTicketsUpdateService {
  return stubService<ProjectsTicketsUpdateService>({});
}

describe("GitConnectionsService — credential table usage", () => {
  it("createConnection inserts a row into integration_git_connection_credentials in the same call", async () => {
    const insertMock = jest.fn();
    const valuesMock = jest.fn().mockResolvedValue([]);
    insertMock.mockReturnValue({ values: valuesMock });

    const returningMock = jest.fn().mockResolvedValue([
      { id: CONN_ID, provider: "github", projectId: null, repoUrl: "https://github.com/a/b", repoName: "b", isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const firstInsertValues = jest.fn().mockReturnValue({ returning: returningMock });
    insertMock.mockReturnValueOnce({ values: firstInsertValues });

    const db = {
      insert: insertMock,
    } as unknown as Db;

    const svc = new GitConnectionsService(db);
    await svc.createConnection(ORG, "user-1", { provider: "github", repoUrl: "https://github.com/a/b" });

    expect(insertMock).toHaveBeenCalledTimes(2);
    const secondInsertCall = valuesMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(secondInsertCall).toBeDefined();
    expect(secondInsertCall?.orgId).toBe(ORG);
    expect(secondInsertCall?.gitConnectionId).toBe(CONN_ID);
    expect(typeof secondInsertCall?.signingSecret).toBe("string");
    expect(secondInsertCall?.secretSetAt).toBeInstanceOf(Date);
  });

  it("listConnections calls leftJoin with the credentials table — secret is read from credentials, not git_connections", async () => {
    const leftJoinMock = jest.fn();
    const fromChain = {
      leftJoin: leftJoinMock,
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    };
    leftJoinMock.mockReturnValue(fromChain);

    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(fromChain) }),
    } as unknown as Db;

    const svc = new GitConnectionsService(db);
    await svc.listConnections(ORG, { limit: 10 });

    expect(leftJoinMock).toHaveBeenCalledTimes(1);
  });

  it("listConnections masks a secret from the credential row when present", async () => {
    const credRow = {
      id: CONN_ID,
      provider: "github",
      projectId: null,
      repoUrl: "https://github.com/a/b",
      repoName: "b",
      isActive: true,
      signingSecret: GOOD_SECRET,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    };
    const fromChain = {
      leftJoin: jest.fn(),
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([credRow]) }),
      }),
    };
    (fromChain.leftJoin as jest.Mock).mockReturnValue(fromChain);

    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(fromChain) }),
    } as unknown as Db;

    const svc = new GitConnectionsService(db);
    const result = await svc.listConnections(ORG, { limit: 10 });

    expect(result.data[0]?.maskedSecret).toMatch(/^s3cr/);
    expect(result.data[0]?.maskedSecret).not.toContain(GOOD_SECRET);
  });

  it("listConnections returns a placeholder mask when no credential row is present (null from left join)", async () => {
    const row = {
      id: CONN_ID,
      provider: "github",
      projectId: null,
      repoUrl: "https://github.com/a/b",
      repoName: "b",
      isActive: true,
      signingSecret: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    };
    const fromChain = {
      leftJoin: jest.fn(),
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([row]) }),
      }),
    };
    (fromChain.leftJoin as jest.Mock).mockReturnValue(fromChain);

    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(fromChain) }),
    } as unknown as Db;

    const svc = new GitConnectionsService(db);
    const result = await svc.listConnections(ORG, { limit: 10 });

    expect(result.data[0]?.maskedSecret).toBe("••••••••••••");
  });
});

describe("IntegrationsGitService — signature verification uses credential table", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTenantTransaction.mockResolvedValue(undefined);
  });

  function makeRequest(overrides?: Partial<WebhookRequest>): WebhookRequest {
    return {
      connectionIdRaw: String(CONN_ID),
      rawBody: '{"ref":"refs/heads/main"}',
      signature256: "sha256=abc",
      gitlabToken: undefined,
      githubEvent: "push",
      gitlabEvent: undefined,
      deliveryId: "delivery-1",
      ...overrides,
    };
  }

  it("processWebhook queries integration_git_connection_credentials inside the tenant transaction", async () => {
    const selectMock = jest.fn();
    const credSelectChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ signingSecret: GOOD_SECRET }]) }),
      }),
    };
    selectMock.mockReturnValue(credSelectChain);

    let capturedSelectCall = false;
    mockRunInTenantTransaction.mockImplementation(
      async (_db: Db, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            gitConnections: {
              findFirst: jest.fn().mockResolvedValue({ id: CONN_ID, orgId: ORG, isActive: true, provider: "github" }),
            },
          },
          select: jest.fn().mockImplementation(() => {
            capturedSelectCall = true;
            return credSelectChain;
          }),
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        };
        return fn(tx);
      },
    );

    const db = {
      execute: jest.fn().mockResolvedValue([{ org_id: ORG }]),
    } as unknown as Db;

    const svc = new IntegrationsGitService(db, makeTickets());
    await svc.processWebhook(makeRequest());

    expect(capturedSelectCall).toBe(true);
  });

  it("processWebhook denies the webhook when no credential row exists (fail closed)", async () => {
    let signatureCheckReached = false;

    mockRunInTenantTransaction.mockImplementation(
      async (_db: Db, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            gitConnections: {
              findFirst: jest.fn().mockResolvedValue({ id: CONN_ID, orgId: ORG, isActive: true, provider: "github" }),
            },
          },
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        };
        signatureCheckReached = true;
        return fn(tx);
      },
    );

    const db = {
      execute: jest.fn().mockResolvedValue([{ org_id: ORG }]),
    } as unknown as Db;

    const svc = new IntegrationsGitService(db, makeTickets());
    await svc.processWebhook(makeRequest());

    expect(signatureCheckReached).toBe(true);
  });

  it("processWebhook credential WHERE clause includes the connection orgId — cross-tenant read isolated by query", async () => {
    const whereMock = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const credSelectChain = { from: jest.fn().mockReturnValue({ where: whereMock }) };

    mockRunInTenantTransaction.mockImplementation(
      async (_db: Db, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          query: {
            gitConnections: {
              findFirst: jest.fn().mockResolvedValue({ id: CONN_ID, orgId: ORG, isActive: true, provider: "github" }),
            },
          },
          select: jest.fn().mockReturnValue(credSelectChain),
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        };
        return fn(tx);
      },
    );

    const db = {
      execute: jest.fn().mockResolvedValue([{ org_id: ORG }]),
    } as unknown as Db;

    const svc = new IntegrationsGitService(db, makeTickets());
    await svc.processWebhook(makeRequest());

    expect(whereMock).toHaveBeenCalledTimes(1);
    const whereArg = whereMock.mock.calls[0][0];
    function flatten(v: unknown, s = new Set<object>()): unknown[] {
      if (v === null || v === undefined || typeof v !== "object") return [v];
      if (Array.isArray(v)) return v.flatMap((x) => flatten(x, s));
      if (s.has(v)) return [];
      s.add(v);
      const n = v as { queryChunks?: unknown[]; value?: unknown };
      return [
        ...(n.queryChunks ? flatten(n.queryChunks, s) : []),
        ...(Object.prototype.hasOwnProperty.call(n, "value") ? flatten(n.value, s) : []),
      ];
    }
    expect(flatten(whereArg)).toContain(ORG);
    expect(flatten(whereArg)).toContain(CONN_ID);
  });
});
