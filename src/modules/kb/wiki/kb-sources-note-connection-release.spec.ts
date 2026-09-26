jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { KbSourcesController } from "./kb-sources.controller";
import { KbSourcesService } from "./kb-sources.service";
import type { KbAttachmentIndexingService } from "../retrieval/kb-attachment-indexing.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { StorageService } from "../../storage/storage.service";
import type { KbAccessService } from "../core/kb-access.service";
import type { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import type { KbIndexedBytesQuotaService } from "../core/kb-indexed-bytes-quota.service";
import { validateEnv } from "../../../config/env.validation";

const ORG = "org-note-conn-release";

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  role: "member",
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const baseConfig = validateEnv({
  DATABASE_URL: "postgres://test@localhost/note_conn_release_test",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "x".repeat(44),
  CORS_ORIGINS: "http://localhost",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "x".repeat(32),
});

function transactionMock(): jest.Mock {
  return jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction;
}

interface DepthTrace {
  service: KbSourcesService;
  depthAt: Map<string, number>;
  runInTenantTransaction: jest.Mock;
}

function traceDepth(): DepthTrace {
  const depthAt = new Map<string, number>();
  let depth = 0;
  const record = (step: string): void => {
    depthAt.set(step, depth);
  };

  const FAKE_ROW = { id: 42, orgId: ORG } as never;

  const mock = transactionMock();
  mock.mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      depth += 1;
      const fakeTx = {
        insert: jest.fn().mockImplementation(() => ({
          values: jest.fn().mockImplementation(() => ({
            returning: jest.fn().mockImplementation(() => {
              record("dbInsert");
              return Promise.resolve([FAKE_ROW]);
            }),
            then: (
              resolve: (v: undefined) => unknown,
              reject?: (e: unknown) => unknown,
            ): Promise<unknown> => Promise.resolve(undefined).then(resolve, reject),
          })),
        })),
      };
      try {
        return await fn(fakeTx);
      } finally {
        depth -= 1;
      }
    },
  );

  const db = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;

  const attachmentIndexing = {
    indexSource: jest.fn().mockImplementation(() => {
      record("aiEmbed");
      return Promise.resolve(5);
    }),
    removeSourceChunks: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbAttachmentIndexingService;

  const quota = {
    reserve: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as KbIndexedBytesQuotaService;

  const service = new KbSourcesService(
    db,
    {} as unknown as StorageService,
    attachmentIndexing,
    { ...baseConfig, R2_KB_BUCKET_NAME: "kb-files" },
    {} as unknown as KbAccessService,
    {} as unknown as KnowledgeAuthorizationService,
    quota,
  );

  return { service, depthAt, runInTenantTransaction: mock };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe("KbSourcesController — createNote opts out of the ambient tenant transaction", () => {
  it("createNote carries @NoTenantTransaction() so the embedding call never holds a pooled connection through the AI provider's latency", () => {
    const handler: unknown = Reflect.get(KbSourcesController.prototype, "createNote");
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });
});

describe("KbSourcesService.createNote — pooled connection is not held across the embedding call", () => {
  it("runs the embedding call with no transaction open because the AI provider call does not touch the database", async () => {
    const { service, depthAt } = traceDepth();
    await service.createNote(USER, { title: "Note", text: "hello world", spaceId: null });
    expect(depthAt.get("aiEmbed")).toBe(0);
  });

  it("keeps the database insert inside a transaction so the route opt-out never issues a statement without a tenant GUC", async () => {
    const { service, depthAt } = traceDepth();
    await service.createNote(USER, { title: "Note", text: "hello world", spaceId: null });
    expect(depthAt.get("dbInsert")).toBe(1);
  });

  it("opens exactly one short transaction for the DB write, releasing the connection before the embedding call", async () => {
    const { service, runInTenantTransaction: txMock } = traceDepth();
    await service.createNote(USER, { title: "Note", text: "hello world", spaceId: null });
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(txMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ORG },
    );
  });
});
