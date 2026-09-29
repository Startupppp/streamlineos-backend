import { ConflictException } from "@nestjs/common";
import { projectTemplates, projects, ticketComments, tickets } from "../../../../db/schema";
import { ProjectsRestoreService } from "./projects-restore.service";

function chain(rows: unknown[]) {
  const node: Record<string, unknown> = {};
  const self = () => node;
  node.from = self;
  node.where = self;
  node.set = self;
  node.limit = () => rows;
  node.returning = () => rows;
  node.then = (resolve: (value: unknown) => unknown) => resolve(rows);
  return node;
}

const DELETED_AT = new Date("2026-03-01T10:00:00.000Z");

const actor = {
  userId: "user-1",
  orgId: "org-1",
  isOrgOwner: true,
  role: "OWNER",
  sessionId: "s",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
};

function buildService(options: {
  project?: Record<string, unknown> | undefined;
  occupants?: unknown[];
  restoredTickets?: unknown[];
  restoredComments?: unknown[];
  template?: Record<string, unknown> | undefined;
}) {
  const audit = { log: jest.fn(), logCritical: jest.fn() };
  const updates: { table: unknown }[] = [];
  const tx = {
    update: jest.fn((table: unknown) => {
      updates.push({ table });
      if (table === tickets) return chain(options.restoredTickets ?? []);
      if (table === ticketComments) return chain(options.restoredComments ?? []);
      return chain([]);
    }),
  };
  const transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx));
  const db = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(options.project) },
      projectTemplates: {
        findFirst: jest.fn().mockResolvedValue(options.template),
      },
    },
    select: jest.fn(() => chain(options.occupants ?? [])),
    update: jest.fn((table: unknown) => {
      updates.push({ table });
      return chain([]);
    }),
    transaction,
  };
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
  const service = new ProjectsRestoreService(
    db as never,
    audit as never,
    cache as never,
  );
  return { service, audit, transaction, updates, db, cache };
}

describe("ProjectsRestoreService.restoreProject", () => {
  it("refuses when a live project already holds the deleted project's key", async () => {
    const { service, transaction } = buildService({
      project: {
        id: 5,
        name: "Apollo",
        key: "APO",
        intakeToken: "tok",
        deletedAt: DELETED_AT,
      },
      occupants: [{ id: 9, key: "APO" }],
    });

    await expect(service.restoreProject(actor as never, 5)).rejects.toThrow(
      /key "APO" is already held by live project 9/,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("clears deletedAt and cascade-restores only the rows the same delete stamped", async () => {
    const { service, audit, updates } = buildService({
      project: {
        id: 5,
        name: "Apollo",
        key: "APO",
        intakeToken: "tok",
        deletedAt: DELETED_AT,
      },
      occupants: [],
      restoredTickets: [{ id: 11 }, { id: 12 }],
      restoredComments: [{ id: 21 }],
    });

    await expect(service.restoreProject(actor as never, 5)).resolves.toEqual({
      restored: true,
      restoredChildren: 3,
    });
    expect(updates.map((u) => u.table)).toEqual([
      projects,
      tickets,
      ticketComments,
    ]);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.restored",
        metadata: expect.objectContaining({
          restoredTickets: 2,
          restoredComments: 1,
          deletedAt: DELETED_AT.toISOString(),
        }),
      }),
    );
  });

  it("refuses a project that is not deleted", async () => {
    const { service, transaction } = buildService({
      project: {
        id: 5,
        name: "Apollo",
        key: "APO",
        intakeToken: "tok",
        deletedAt: null,
      },
    });

    await expect(
      service.restoreProject(actor as never, 5),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("ProjectsRestoreService.restoreTemplate", () => {
  it("clears deletedAt and writes an audit row", async () => {
    const { service, audit, updates } = buildService({
      template: { id: 7, name: "Kickoff", deletedAt: DELETED_AT },
    });

    await expect(service.restoreTemplate(actor as never, 7)).resolves.toEqual({
      restored: true,
      restoredChildren: 0,
    });
    expect(updates.map((u) => u.table)).toEqual([projectTemplates]);
    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "build.template.restored" }),
    );
  });

  it("refuses a template that is not deleted", async () => {
    const { service, audit } = buildService({
      template: { id: 7, name: "Kickoff", deletedAt: null },
    });

    await expect(
      service.restoreTemplate(actor as never, 7),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.logCritical).not.toHaveBeenCalled();
  });
});
