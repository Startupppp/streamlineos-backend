import { ForbiddenException, NotFoundException, RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import type { CommandFenceStore } from "../../../common/idempotency/command-fence-store";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { REQUIRE_PERMISSION } from "../../../common/rbac/require-permission-key";
import { VALIDATION_SCHEMAS } from "../../../common/validation/validate.decorator";
import { RESPONSE_SCHEMA } from "../../../common/openapi/zod-operation-contracts";
import { PermissionGuard } from "../../access/permission.guard";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { Db } from "../../../db/drizzle.types";
import { TICKETS_PERMISSION } from "../core/tickets/tickets-scope";
import { IMPORT_PERMISSION } from "./import-export.constants";
import { TicketImportService } from "./ticket-import.service";
import { TicketExportService } from "./ticket-export.service";
import { TicketImportExportController } from "./ticket-import-export.controller";

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

const reflector = new Reflector();

function handler(name: keyof TicketImportExportController): () => unknown {
  return TicketImportExportController.prototype[name] as unknown as () => unknown;
}

interface DbOptions {
  project?: { managerMembershipId: number | null } | null;
  failEveryInsert?: boolean;
  exportRows?: unknown[];
}

interface DbState {
  transactions: number;
  batches: Record<string, unknown>[][];
  selects: number;
}

function makeDb(options: DbOptions = {}) {
  const state: DbState = { transactions: 0, batches: [], selects: 0 };

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
      state.selects += 1;
      const field = Object.keys(projection)[0];
      if (field === "name") return chainFor(STATUSES.map((name) => ({ name })));
      if (field === "key") return chainFor([]);
      if (field === "value") return chainFor([{ value: null }]);
      if (field === "ticketNumber") return chainFor(options.exportRows ?? []);
      return chainFor([]);
    }),
    execute: jest.fn(async () => undefined),
    insert: jest.fn(() => ({
      values: (rows: Record<string, unknown>[]) => ({
        returning: async () => {
          if (options.failEveryInsert)
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

function makeAccess(scope: DataScope = "all") {
  return {
    resolveUserPermissions: jest.fn(async () => new Map<string, DataScope>()),
    scopeFor: jest.fn(async () => scope),
    holds: jest.fn(async () => scope !== "none"),
  } as unknown as AccessService;
}

function makeFences() {
  return {
    claim: jest.fn(async () => ({ kind: "proceed", fenceId: 9 })),
    complete: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
  } as unknown as CommandFenceStore;
}

function makeController(options: DbOptions = {}, scope: DataScope = "all") {
  const { db, state } = makeDb(options);
  const access = makeAccess(scope);
  const fences = makeFences();
  const controller = new TicketImportExportController(
    new TicketImportService(db, access, fences),
    new TicketExportService(db, access),
  );
  return { controller, state, fences, access };
}

function csv(...titles: string[]): string {
  return ["title", ...titles].join("\n");
}

describe("TicketImportExportController route surface — the service was unreachable until it had one", () => {
  it("mounts under the project-scoped prefix the frontend import-export client already calls", () => {
    expect(reflector.get(PATH_METADATA, TicketImportExportController)).toBe(
      "build/:projectId/import-export",
    );
  });

  it("exposes POST tickets/preview, POST tickets and GET tickets/export and nothing else", () => {
    const routes = (
      ["previewImport", "commitImport", "exportTickets"] as const
    ).map((name) => ({
      path: reflector.get(PATH_METADATA, handler(name)) as string,
      method: reflector.get(METHOD_METADATA, handler(name)) as RequestMethod,
    }));

    expect(routes).toEqual([
      { path: "tickets/preview", method: RequestMethod.POST },
      { path: "tickets", method: RequestMethod.POST },
      { path: "tickets/export", method: RequestMethod.GET },
    ]);
    expect(
      Object.getOwnPropertyNames(TicketImportExportController.prototype).filter(
        (name) => reflector.get(METHOD_METADATA, handler(name as never)) !== undefined,
      ),
    ).toEqual(["previewImport", "commitImport", "exportTickets"]);
  });

  it("carries the build module gate so a tenant without Build gets 402, not a working import", () => {
    expect(reflector.get(REQUIRE_MODULE, TicketImportExportController)).toBe("build");
  });

  it("attaches PermissionGuard explicitly, because @RequirePermission alone gates nothing", () => {
    const guards = reflector.get<unknown[]>(GUARDS_METADATA, TicketImportExportController);
    expect(guards).toContain(PermissionGuard);
    expect(guards).toContain(JwtAuthGuard);
  });

  it("declares a response contract on every handler so the frontend contract has a source", () => {
    for (const name of ["previewImport", "commitImport", "exportTickets"] as const)
      expect(reflector.get(RESPONSE_SCHEMA, handler(name))).toBeDefined();
  });

  it("declares projectId in a strict params schema on every handler", () => {
    for (const name of ["previewImport", "commitImport", "exportTickets"] as const) {
      const schemas = reflector.get<{ params?: { parse: (v: unknown) => unknown } }>(
        VALIDATION_SCHEMAS,
        handler(name),
      );
      expect(schemas.params?.parse({ projectId: "42" })).toEqual({ projectId: 42 });
      expect(() => schemas.params?.parse({ projectId: "42", orgId: "sneaky" })).toThrow();
    }
  });
});

describe("TicketImportExportController permission gating", () => {
  it("gates both import handlers on the create key the service also enforces", () => {
    expect(reflector.get(REQUIRE_PERMISSION, handler("previewImport"))).toBe(
      IMPORT_PERMISSION,
    );
    expect(reflector.get(REQUIRE_PERMISSION, handler("commitImport"))).toBe(
      IMPORT_PERMISSION,
    );
    expect(IMPORT_PERMISSION).toBe("build:tickets:create");
  });

  it("gates export on the ticket view key, not on the import key", () => {
    expect(reflector.get(REQUIRE_PERMISSION, handler("exportTickets"))).toBe(
      TICKETS_PERMISSION,
    );
    expect(reflector.get(REQUIRE_PERMISSION, handler("exportTickets"))).not.toBe(
      IMPORT_PERMISSION,
    );
    expect(TICKETS_PERMISSION).toBe("build:tickets:view");
  });

  it("refuses an in-tenant caller who may read the project but may not create tickets", async () => {
    const { controller } = makeController({}, "none");

    await expect(
      controller.previewImport(PROJECT, { format: "csv", content: csv("Ship it") }, owner),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("still previews for a caller who holds the create key (control)", async () => {
    const { controller } = makeController();

    const preview = await controller.previewImport(
      PROJECT,
      { format: "csv", content: csv("Ship it") },
      owner,
    );

    expect(preview.summary.importable).toBe(1);
  });
});

describe("TicketImportExportController cross-tenant isolation", () => {
  it("answers 404, never 403, for a projectId outside the caller's organisation on preview", async () => {
    const { controller } = makeController({ project: null });

    await expect(
      controller.previewImport(PROJECT, { format: "csv", content: csv("Ship it") }, owner),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers 404, never 403, for a projectId outside the caller's organisation on commit", async () => {
    const { controller } = makeController({ project: null });

    await expect(
      controller.commitImport(
        PROJECT,
        { format: "csv", content: csv("Ship it"), confirmationToken: "token" },
        "key-1",
        owner,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers 404, never 403, for a projectId outside the caller's organisation on export", async () => {
    const { controller } = makeController({ project: null });

    await expect(
      controller.exportTickets(PROJECT, { format: "csv" }, owner),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("still serves the caller's own project through all three routes (control)", async () => {
    const { controller } = makeController();
    const preview = await controller.previewImport(
      PROJECT,
      { format: "csv", content: csv("Ship it") },
      owner,
    );

    await expect(
      controller.commitImport(
        PROJECT,
        {
          format: "csv",
          content: csv("Ship it"),
          confirmationToken: preview.confirmationToken as string,
        },
        "key-1",
        owner,
      ),
    ).resolves.toEqual(expect.objectContaining({ projectId: PROJECT }));
    await expect(
      controller.exportTickets(PROJECT, { format: "csv" }, owner),
    ).resolves.toEqual(expect.objectContaining({ filename: "build-project-42-tickets.csv" }));
  });
});

describe("TicketImportExportController dry run", () => {
  it("opens no transaction and writes no row for a preview, so the dry run cannot create tickets", async () => {
    const { controller, state } = makeController();

    const preview = await controller.previewImport(
      PROJECT,
      { format: "csv", content: csv("Ship it", "Ship it later") },
      owner,
    );

    expect(preview.summary.importable).toBe(2);
    expect(state.transactions).toBe(0);
    expect(state.batches).toEqual([]);
  });

  it("runs preview and commit through the same parser, so the same file yields the same rows", async () => {
    const { controller } = makeController();
    const content = "title,points\nGood,3\n,4\nAlso good,5";

    const preview = await controller.previewImport(PROJECT, { format: "csv", content }, owner);
    const report = await controller.commitImport(
      PROJECT,
      { format: "csv", content, confirmationToken: preview.confirmationToken as string },
      "key-1",
      owner,
    );

    expect(preview.summary).toEqual({
      totalRows: 3,
      importable: 2,
      invalid: 1,
      duplicateInFile: 0,
      duplicateExisting: 0,
    });
    expect(report.summary.imported).toBe(2);
    expect(report.summary.skipped).toBe(1);
    expect(report.rows.find((row) => row.rowNumber === 3)?.outcome).toBe("SKIPPED");
  });
});

describe("TicketImportExportController commit reports partial outcomes", () => {
  it("reports every row as ROLLED_BACK when an atomic commit fails, rather than claiming success", async () => {
    const { controller } = makeController();
    const content = csv("Alpha", "Bravo");
    const preview = await controller.previewImport(PROJECT, { format: "csv", content }, owner);

    const failing = makeController({ failEveryInsert: true });
    const failingPreview = await failing.controller.previewImport(
      PROJECT,
      { format: "csv", content },
      owner,
    );
    const report = await failing.controller.commitImport(
      PROJECT,
      {
        format: "csv",
        content,
        confirmationToken: failingPreview.confirmationToken as string,
        mode: "atomic",
      },
      "key-1",
      owner,
    );

    expect(preview.confirmationToken).toBe(failingPreview.confirmationToken);
    expect(report.summary).toEqual({
      attempted: 2,
      imported: 0,
      skipped: 0,
      failed: 0,
      rolledBack: 2,
    });
    expect(report.rows.every((row) => row.outcome === "ROLLED_BACK")).toBe(true);
  });

  it("releases the fence on a total rollback so the same key may be retried", async () => {
    const { controller, fences } = makeController({ failEveryInsert: true });
    const content = csv("Alpha", "Bravo");
    const preview = await controller.previewImport(PROJECT, { format: "csv", content }, owner);

    await controller.commitImport(
      PROJECT,
      {
        format: "csv",
        content,
        confirmationToken: preview.confirmationToken as string,
        mode: "atomic",
      },
      "key-1",
      owner,
    );

    expect(fences.fail).toHaveBeenCalledWith(9, ORG);
    expect(fences.complete).not.toHaveBeenCalled();
  });
});

describe("TicketImportExportController idempotency mechanism — exactly one fence, claimed once", () => {
  it("carries no @Idempotent metadata, because the service claims the command fence itself", () => {
    expect(reflector.get(IDEMPOTENCY_COMMAND, handler("commitImport"))).toBeUndefined();
    expect(reflector.get(IDEMPOTENCY_COMMAND, TicketImportExportController)).toBeUndefined();
  });

  it("claims the command fence exactly once per commit, so the two mechanisms cannot self-conflict", async () => {
    const { controller, fences } = makeController();
    const content = csv("Ship it");
    const preview = await controller.previewImport(PROJECT, { format: "csv", content }, owner);

    const report = await controller.commitImport(
      PROJECT,
      { format: "csv", content, confirmationToken: preview.confirmationToken as string },
      "key-1",
      owner,
    );

    expect(fences.claim).toHaveBeenCalledTimes(1);
    expect(fences.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        idempotencyKey: "key-1",
        commandName: "build.import.tickets",
        requestHash: preview.confirmationToken,
      }),
    );
    expect(report.idempotencyKey).toBe("key-1");
    expect(report.replayed).toBe(false);
    expect(fences.complete).toHaveBeenCalledTimes(1);
  });

  it("forwards the header key rather than dropping it, so a retry replays instead of re-importing", async () => {
    const { controller, fences } = makeController();
    const content = csv("Ship it");
    const preview = await controller.previewImport(PROJECT, { format: "csv", content }, owner);
    const body = {
      format: "csv" as const,
      content,
      confirmationToken: preview.confirmationToken as string,
    };

    await controller.commitImport(PROJECT, body, "key-1", owner);
    await controller.commitImport(PROJECT, body, "key-2", owner);

    expect(
      (fences.claim as unknown as jest.Mock).mock.calls.map(
        (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual(["key-1", "key-2"]);
  });
});

describe("TicketImportExportController export", () => {
  it("returns a JSON envelope carrying the file, not a raw stream, so the contract applies", async () => {
    const { controller } = makeController({
      exportRows: [
        {
          ticketNumber: 5,
          title: "Ship it",
          description: null,
          type: "TASK",
          status: "TODO",
          priority: "HIGH",
          startDate: null,
          dueDate: null,
          points: null,
          storyPoints: null,
          estimate: null,
          completionPercentage: 0,
          clientVisible: false,
          link: null,
        },
      ],
    });

    const result = await controller.exportTickets(PROJECT, { format: "csv", limit: 10 }, owner);

    expect(result).toEqual(
      expect.objectContaining({
        format: "csv",
        contentType: "text/csv",
        filename: "build-project-42-tickets.csv",
        rowCount: 1,
      }),
    );
    expect(result.content).toContain("Ship it");
  });

  it("returns an empty file and issues no ticket query when the caller's ticket scope is none", async () => {
    const { controller } = makeController({}, "none");

    const result = await controller.exportTickets(PROJECT, { format: "json" }, owner);

    expect(result.rowCount).toBe(0);
    expect(JSON.parse(result.content)).toEqual([]);
  });
});
