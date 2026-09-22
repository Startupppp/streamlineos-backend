import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CommandFenceStore } from "../../../common/idempotency/command-fence-store";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.types";
import { TicketImportService } from "./ticket-import.service";
import type { TicketImportReport } from "./ticket-import-report";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = 42;
const STATUSES = ["TODO", "IN_PROGRESS", "DONE"];

const owner: CurrentUserContext = {
  orgId: ORG,
  userId: "user-owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const manager: CurrentUserContext = {
  ...owner,
  userId: "user-manager",
  role: "MEMBER",
  isOrgOwner: false,
  principal: humanSessionPrincipal(7, false),
};

interface DbOptions {
  project?: { managerMembershipId: number | null };
  statuses?: string[];
  conflicting?: string[];
  maxTicketNumber?: number | null;
  failBatchAt?: number;
}

interface DbState {
  batches: Record<string, unknown>[][];
  transactions: number;
  locks: number;
}

function makeDb(options: DbOptions = {}) {
  const state: DbState = { batches: [], transactions: 0, locks: 0 };
  let batchCount = 0;

  const chainFor = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    });
    return chain;
  };

  const db: Record<string, unknown> = {
    query: {
      projects: {
        findFirst: jest.fn(async () =>
          "project" in options ? options.project : { managerMembershipId: null },
        ),
      },
    },
    select: jest.fn((projection: Record<string, unknown>) => {
      const field = Object.keys(projection)[0];
      if (field === "name")
        return chainFor((options.statuses ?? STATUSES).map((name) => ({ name })));
      if (field === "key")
        return chainFor((options.conflicting ?? []).map((key) => ({ key })));
      if (field === "value")
        return chainFor([{ value: options.maxTicketNumber ?? null }]);
      return chainFor([]);
    }),
    execute: jest.fn(async () => {
      state.locks += 1;
    }),
    insert: jest.fn(() => ({
      values: (rows: Record<string, unknown>[]) => ({
        returning: async () => {
          batchCount += 1;
          if (options.failBatchAt === batchCount)
            throw new Error("duplicate key value violates unique constraint");
          state.batches.push(rows);
          return rows.map((row) => ({ id: 1000 + Number(row.ticketNumber) }));
        },
      }),
    })),
    transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      return run(db);
    }),
  };

  return { db: db as unknown as Db, state };
}

function makeAccess(holds = true) {
  return {
    resolveUserPermissions: jest.fn(async () => new Map<string, string>()),
    holds: jest.fn(async () => holds),
    scopeFor: jest.fn(async () => "all"),
  } as unknown as AccessService;
}

function makeFences(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    claim: jest.fn(async () => ({ kind: "proceed", fenceId: 9 })),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CommandFenceStore;
}

function csv(...titles: string[]): string {
  return ["title", ...titles].join("\n");
}

describe("TicketImportService.previewImport", () => {
  it("returns a dry run without opening a transaction or writing a row", async () => {
    const { db, state } = makeDb();
    const service = new TicketImportService(db, makeAccess(), makeFences());

    const preview = await service.previewImport(owner, PROJECT, {
      format: "csv",
      content: csv("Ship it"),
    });

    expect(preview.summary.importable).toBe(1);
    expect(preview.confirmationToken).not.toBeNull();
    expect(state.transactions).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("surfaces existing project titles as duplicates", async () => {
    const { db } = makeDb({ conflicting: ["ship it"] });
    const service = new TicketImportService(db, makeAccess(), makeFences());

    const preview = await service.previewImport(owner, PROJECT, {
      format: "csv",
      content: csv("Ship it"),
    });

    expect(preview.summary.duplicateExisting).toBe(1);
    expect(preview.confirmationToken).toBeNull();
  });
});

describe("TicketImportService authorization", () => {
  it("refuses a project that is not in the caller's organisation", async () => {
    const { db } = makeDb({ project: undefined });
    const service = new TicketImportService(db, makeAccess(), makeFences());

    await expect(
      service.previewImport(owner, PROJECT, { format: "csv", content: csv("Ship it") }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("refuses a caller who may reach the project but may not create tickets", async () => {
    const { db, state } = makeDb({ project: { managerMembershipId: 7 } });
    const service = new TicketImportService(db, makeAccess(false), makeFences());

    await expect(
      service.commitImport(manager, PROJECT, {
        format: "csv",
        content: csv("Ship it"),
        confirmationToken: "anything",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(state.batches).toEqual([]);
  });
});

describe("TicketImportService.commitImport confirmation boundary", () => {
  it("refuses a token that does not match the file being committed", async () => {
    const { db, state } = makeDb();
    const service = new TicketImportService(db, makeAccess(), makeFences());

    await expect(
      service.commitImport(owner, PROJECT, {
        format: "csv",
        content: csv("Ship it"),
        confirmationToken: "stale-token",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state.batches).toEqual([]);
  });

  it("refuses a file in which nothing is importable", async () => {
    const { db, state } = makeDb({ conflicting: ["ship it"] });
    const service = new TicketImportService(db, makeAccess(), makeFences());

    await expect(
      service.commitImport(owner, PROJECT, {
        format: "csv",
        content: csv("Ship it"),
        confirmationToken: "anything",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(state.batches).toEqual([]);
  });

  it("writes only once the token from the preview is presented back", async () => {
    const { db, state } = makeDb({ maxTicketNumber: 4 });
    const service = new TicketImportService(db, makeAccess(), makeFences());
    const content = csv("Ship it", "Ship it later");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    const report = await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      confirmationToken: preview.confirmationToken as string,
    });

    expect(report.summary).toEqual({
      attempted: 2,
      imported: 2,
      skipped: 0,
      failed: 0,
      rolledBack: 0,
    });
    expect(state.locks).toBe(1);
    expect(state.batches[0]?.map((row) => row.ticketNumber)).toEqual([5, 6]);
    expect(state.batches[0]?.[0]?.orgId).toBe(ORG);
    expect(state.batches[0]?.[0]?.projectId).toBe(PROJECT);
  });

  it("never assigns a field the file was not allowed to carry", async () => {
    const { db, state } = makeDb();
    const service = new TicketImportService(db, makeAccess(), makeFences());
    const content = "title,assigneeMembershipId\nShip it,999\nClean up,";
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    expect(preview.issues).toEqual([
      {
        rowNumber: 2,
        field: "assigneeMembershipId",
        kind: "INVALID",
        message: '"assigneeMembershipId" is not an importable field',
      },
    ]);

    await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      confirmationToken: preview.confirmationToken as string,
    });

    expect(state.batches[0]).toHaveLength(1);
    expect(state.batches[0]?.[0]).not.toHaveProperty("assigneeMembershipId");
    expect(state.batches[0]?.[0]?.title).toBe("Clean up");
  });
});

describe("TicketImportService.commitImport reporting", () => {
  async function commit(
    options: DbOptions,
    content: string,
    mode?: "atomic" | "partial",
  ): Promise<{ report: TicketImportReport; state: DbState }> {
    const { db, state } = makeDb(options);
    const service = new TicketImportService(db, makeAccess(), makeFences());
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });
    const report = await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      mode,
      confirmationToken: preview.confirmationToken as string,
    });
    return { report, state };
  }

  it("reports every rejected row as skipped alongside the imported ones", async () => {
    const { report } = await commit({}, "title,points\nGood,3\n,4\nAlso good,5");
    expect(report.summary.imported).toBe(2);
    expect(report.summary.skipped).toBe(1);
    expect(report.rows.find((row) => row.rowNumber === 3)).toEqual({
      rowNumber: 3,
      outcome: "SKIPPED",
      ticketId: null,
      message: "Title is required",
    });
  });

  it("rolls the whole import back when a batch fails in atomic mode", async () => {
    const { report } = await commit({ failBatchAt: 1 }, csv("A", "B"), "atomic");
    expect(report.summary).toEqual({
      attempted: 2,
      imported: 0,
      skipped: 0,
      failed: 0,
      rolledBack: 2,
    });
    expect(report.rows.every((row) => row.outcome === "ROLLED_BACK")).toBe(true);
  });

  it("keeps the batches that succeeded and reports the ones that failed in partial mode", async () => {
    const titles = Array.from({ length: 150 }, (_, index) => `Ticket ${index}`);
    const { report, state } = await commit({ failBatchAt: 2 }, csv(...titles), "partial");

    expect(state.transactions).toBe(2);
    expect(report.summary.imported).toBe(100);
    expect(report.summary.failed).toBe(50);
    expect(report.rows.filter((row) => row.outcome === "FAILED")).toHaveLength(50);
  });

  it("splits an import into bounded batches", async () => {
    const titles = Array.from({ length: 250 }, (_, index) => `Ticket ${index}`);
    const { state } = await commit({}, csv(...titles));
    expect(state.batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
  });
});

describe("TicketImportService.commitImport idempotency", () => {
  it("claims no fence when the caller supplies no key", async () => {
    const { db } = makeDb();
    const fences = makeFences();
    const service = new TicketImportService(db, makeAccess(), fences);
    const content = csv("Ship it");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      confirmationToken: preview.confirmationToken as string,
    });

    expect(fences.claim).not.toHaveBeenCalled();
  });

  it("fences the command on the confirmation token and records the report", async () => {
    const { db } = makeDb();
    const fences = makeFences();
    const service = new TicketImportService(db, makeAccess(), fences);
    const content = csv("Ship it");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: "key-1",
    });

    expect(fences.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        idempotencyKey: "key-1",
        commandName: "build.import.tickets",
        requestHash: preview.confirmationToken,
      }),
    );
    expect(fences.complete).toHaveBeenCalled();
  });

  it("replays the stored report instead of importing twice", async () => {
    const stored = { projectId: PROJECT, summary: { imported: 3 } };
    const { db, state } = makeDb();
    const fences = makeFences({
      claim: jest.fn(async () => ({
        kind: "replay",
        responseBody: stored,
        responseStatus: 200,
      })),
    });
    const service = new TicketImportService(db, makeAccess(), fences);
    const content = csv("Ship it");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    const report = await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: "key-1",
    });

    expect(report.replayed).toBe(true);
    expect(report.summary.imported).toBe(3);
    expect(state.batches).toEqual([]);
  });

  it("rejects a key already in flight", async () => {
    const { db } = makeDb();
    const fences = makeFences({ claim: jest.fn(async () => ({ kind: "inflight" })) });
    const service = new TicketImportService(db, makeAccess(), fences);
    const content = csv("Ship it");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    await expect(
      service.commitImport(owner, PROJECT, {
        format: "csv",
        content,
        confirmationToken: preview.confirmationToken as string,
        idempotencyKey: "key-1",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a key that was used for a different file", async () => {
    const { db } = makeDb();
    const fences = makeFences({ claim: jest.fn(async () => ({ kind: "mismatch" })) });
    const service = new TicketImportService(db, makeAccess(), fences);
    const content = csv("Ship it");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });

    await expect(
      service.commitImport(owner, PROJECT, {
        format: "csv",
        content,
        confirmationToken: preview.confirmationToken as string,
        idempotencyKey: "key-1",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("releases the fence when the whole import rolled back, so the key can be retried", async () => {
    const { db } = makeDb();
    const fences = makeFences();
    const service = new TicketImportService(db, makeAccess(), fences);
    const content = csv("Ship it");
    const preview = await service.previewImport(owner, PROJECT, { format: "csv", content });
    (db.transaction as unknown as jest.Mock).mockRejectedValueOnce(new Error("connection lost"));

    const report = await service.commitImport(owner, PROJECT, {
      format: "csv",
      content,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: "key-1",
    });

    expect(report.summary.rolledBack).toBe(1);
    expect(fences.fail).toHaveBeenCalledWith(9, ORG);
    expect(fences.complete).not.toHaveBeenCalled();
  });
});
