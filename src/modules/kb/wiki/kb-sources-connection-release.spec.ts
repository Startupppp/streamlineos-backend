jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

jest.mock("../../../common/tenant/tenant-context", () => ({
  ...jest.requireActual("../../../common/tenant/tenant-context"),
  registerAfterCommit: jest.fn(),
}));

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn(async () => undefined) },
}));

import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { KbSourcesController } from "./kb-sources.controller";
import { KbSourcesService } from "./kb-sources.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { StorageService } from "../../storage/storage.service";

const ORG = "org-sources-release";
const FILE_BYTES = Buffer.from("# runbook\n");

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  role: "member",
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function transactionMock(): jest.Mock {
  return jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction;
}

function afterCommitMock(): jest.Mock {
  return jest.requireMock<{ registerAfterCommit: jest.Mock }>(
    "../../../common/tenant/tenant-context",
  ).registerAfterCommit;
}

interface Trace {
  readonly service: KbSourcesService;
  readonly steps: string[];
  readonly depthAt: Map<string, number>;
  readonly runInTenantTransaction: jest.Mock;
  readonly indexSource: jest.Mock;
}

function trace(options: { deferred: boolean } = { deferred: true }): Trace {
  const steps: string[] = [];
  const depthAt = new Map<string, number>();
  let depth = 0;
  const record = (step: string): void => {
    steps.push(step);
    depthAt.set(step, depth);
  };

  const tx = {
    insert: jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(async () => {
          record("sourceRowInsert");
          return [{ id: 77, kind: "file", orgId: ORG }];
        }),
      })),
    })),
  };

  const runInTenantTransaction = transactionMock();
  runInTenantTransaction.mockImplementation(
    async (_db: unknown, fn: (t: unknown) => Promise<unknown>) => {
      record("transactionOpen");
      depth += 1;
      try {
        return await fn(tx);
      } finally {
        depth -= 1;
        record("transactionClose");
      }
    },
  );

  afterCommitMock().mockImplementation(() => {
    record("registerAfterCommit");
    return options.deferred;
  });

  const db = {
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(async () => {
          record("sourceStatusUpdate");
          return [];
        }),
      })),
    })),
  } as unknown as Db;

  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadFile: jest.fn(async () => {
      record("objectStoreUpload");
      return {
        key: `${ORG}/kb-sources/runbook.md`,
        size: FILE_BYTES.length,
        mimeType: "text/markdown",
        sha256: "a".repeat(64),
      };
    }),
  };

  const indexSource = jest.fn(async () => {
    record("indexSource");
    return 1;
  });

  const service = new KbSourcesService(
    db,
    storage as unknown as StorageService,
    { indexSource, removeSourceChunks: jest.fn() } as never,
    { R2_KB_BUCKET_NAME: "kb-files" } as never,
    {} as never,
    {} as never,
    {
      reserve: jest.fn(async () => {
        record("quotaReserve");
      }),
      release: jest.fn(async () => undefined),
    } as never,
  );

  return { service, steps, depthAt, runInTenantTransaction, indexSource };
}

function markdownUpload(): Express.Multer.File {
  return {
    mimetype: "text/markdown",
    buffer: FILE_BYTES,
    originalname: "runbook.md",
    size: FILE_BYTES.length,
  } as unknown as Express.Multer.File;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe("KbSourcesController — the 25 MB source upload opts out of the ambient tenant transaction", () => {
  it("the upload route carries @NoTenantTransaction(), because a slow client uplink otherwise holds a pooled connection for the whole transfer", () => {
    const handler: unknown = Reflect.get(KbSourcesController.prototype, "upload");

    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBe(true);
  });

  it("the list route carries no such metadata, so the assertion above reads a decorator rather than a default", () => {
    const handler: unknown = Reflect.get(KbSourcesController.prototype, "list");

    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(handler))).toBeUndefined();
  });
});

describe("KbSourcesService.createFile — where the pooled connection is held", () => {
  it("streams the file to object storage before any transaction is opened, so ten concurrent uploads cannot take the replica offline", async () => {
    const { service, steps, depthAt } = trace();

    await service.createFile(USER, markdownUpload());

    expect(depthAt.get("objectStoreUpload")).toBe(0);
    expect(steps.indexOf("objectStoreUpload")).toBeLessThan(
      steps.indexOf("transactionOpen"),
    );
  });

  it("opens exactly one tenant transaction for the database work and closes it after the insert, rather than one spanning the upload", async () => {
    const { service, steps, runInTenantTransaction } = trace();

    await service.createFile(USER, markdownUpload());

    expect(runInTenantTransaction).toHaveBeenCalledTimes(1);
    expect(runInTenantTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { orgId: ORG },
    );
    expect(steps).toEqual([
      "objectStoreUpload",
      "transactionOpen",
      "quotaReserve",
      "sourceRowInsert",
      "registerAfterCommit",
      "transactionClose",
    ]);
  });

  it("keeps the quota reservation and the source row inside that transaction, so opting the route out never issues a statement without a tenant GUC", async () => {
    const { service, depthAt } = trace();

    await service.createFile(USER, markdownUpload());

    expect(depthAt.get("quotaReserve")).toBe(1);
    expect(depthAt.get("sourceRowInsert")).toBe(1);
  });

  it("registers the indexing work while the transaction is still open, because registerAfterCommit on a dead context answers false and the deferral is lost", async () => {
    const { service, depthAt } = trace();

    await service.createFile(USER, markdownUpload());

    expect(depthAt.get("registerAfterCommit")).toBe(1);
  });

  it("runs the fallback indexing after the transaction closes when the deferral is refused, so extraction and embedding never borrow the connection", async () => {
    const { service, steps, depthAt } = trace({ deferred: false });

    await service.createFile(USER, markdownUpload());

    expect(depthAt.get("indexSource")).toBe(0);
    expect(steps.indexOf("transactionClose")).toBeLessThan(
      steps.indexOf("indexSource"),
    );
  });
});
