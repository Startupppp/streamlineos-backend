import { NotFoundException } from "@nestjs/common";
import { Column, SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import {
  outboxEvents,
  projectMembers,
  projectReleases,
  projectTeamAssignments,
  projects,
  releaseTickets,
  tickets,
} from "../../../../db/schema";
import { ProjectsReleasesService } from "./projects-releases.service";
import { lifecycleAuditDouble } from "../../lifecycle/audit-double";
import { MEMBER_STANDING, projectAccessRow, standingAccess } from "../../__tests__/project-access-doubles";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP_ID = 7;
const OTHER_MANAGER_MEMBERSHIP_ID = 999;
const PROJECT_A = 11;
const PROJECT_B = 22;
const RELEASE_A = 500;
const RELEASE_B = 501;
const TICKET_A = 900;
const TICKET_B = 901;

type Row = Record<string, unknown>;

interface Predicate {
  key: string;
  op: "eq" | "isNull";
  value?: unknown;
}

function columnKey(column: Column): string {
  const table = column.table as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(table)) {
    if (value === column) return key;
  }
  return column.name;
}

function chunkText(chunk: unknown): string {
  const value = (chunk as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? value.join("").trim() : "";
}

function collect(node: unknown, out: Predicate[]): Predicate[] {
  if (!(node instanceof SQL)) return out;
  const chunks = node.queryChunks as unknown[];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk instanceof SQL) {
      collect(chunk, out);
      continue;
    }
    if (!(chunk instanceof Column)) continue;
    const operator = chunkText(chunks[index + 1]);
    if (operator === "=") {
      const param = chunks[index + 2] as { value?: unknown };
      out.push({ key: columnKey(chunk), op: "eq", value: param?.value });
    } else if (operator === "is null") {
      out.push({ key: columnKey(chunk), op: "isNull" });
    }
  }
  return out;
}

function matches(where: unknown, row: Row): boolean {
  const predicates = collect(where, []);
  expect(predicates.length).toBeGreaterThan(0);
  return predicates.every((predicate) =>
    predicate.op === "isNull"
      ? row[predicate.key] === null || row[predicate.key] === undefined
      : row[predicate.key] === predicate.value,
  );
}

interface Store {
  projects: Row[];
  projectMembers: Row[];
  releases: Row[];
  tickets: Row[];
  links: Row[];
}

function makeStore(): Store {
  return {
    projects: [
      { id: PROJECT_A, orgId: ORG, managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID, deletedAt: null },
      { id: PROJECT_B, orgId: ORG, managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID, deletedAt: null },
    ],
    projectMembers: [{ projectId: PROJECT_A, orgId: ORG, role: "MEMBER" }],
    releases: [
      {
        id: RELEASE_A,
        orgId: ORG,
        projectId: PROJECT_A,
        name: "release-a",
        version: "1.0.0",
        description: null,
        status: "draft",
        releaseDate: null,
        rowVersion: 1,
        createdBy: "user-7",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      {
        id: RELEASE_B,
        orgId: ORG,
        projectId: PROJECT_B,
        name: "release-b",
        version: "2.0.0",
        description: null,
        status: "draft",
        releaseDate: null,
        rowVersion: 1,
        createdBy: "user-9",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
    ],
    tickets: [
      { id: TICKET_A, orgId: ORG, projectId: PROJECT_A, deletedAt: null },
      { id: TICKET_B, orgId: ORG, projectId: PROJECT_B, deletedAt: null },
    ],
    links: [{ orgId: ORG, releaseId: RELEASE_A, ticketId: TICKET_A }],
  };
}

interface Fixture {
  db: Db;
  store: Store;
  outbox: Row[];
  transaction: jest.Mock;
}

function makeDb(store: Store): Fixture {
  const outbox: Row[] = [];

  const findFirst = (rows: Row[]) =>
    jest.fn(async (args: { where?: unknown }) => rows.find((row) => matches(args.where, row)));

  const selectFrom = (table: unknown) => {
    if (table === projects) {
      return {
        where: (where: unknown) => ({
          limit: async () =>
            store.projects
              .filter((row) => matches(where, row))
              .map((row) =>
                projectAccessRow({
                  memberRole:
                    store.projectMembers.find((member) => member.projectId === row.id)?.role === "MEMBER" ? "MEMBER" : null,
                }),
              ),
        }),
      };
    }
    if (table === projectMembers) {
      const chain: Record<string, unknown> = {
        innerJoin: () => chain,
        where: (where: unknown) => ({
          limit: async () =>
            store.projectMembers
              .filter((row) => matches(where, row))
              .map((row) => ({ role: row.role })),
        }),
      };
      return chain;
    }
    if (table === projectTeamAssignments) {
      const chain: Record<string, unknown> = {
        innerJoin: () => chain,
        where: () => ({ limit: async () => [] }),
      };
      return chain;
    }
    if (table === releaseTickets) {
      return {
        where: async (where: unknown) => [
          { ticketCount: store.links.filter((row) => matches(where, row)).length },
        ],
      };
    }
    throw new Error(`unexpected select from ${String(table)}`);
  };

  const updateBuilder = (table: unknown) => ({
    set: (values: Row) => ({
      where: (where: unknown) => {
        const hit = table === projectReleases ? store.releases.filter((row) => matches(where, row)) : [];
        for (const row of hit) Object.assign(row, values);
        return { returning: async () => hit.map((row) => ({ ...row })) };
      },
    }),
  });

  const insertBuilder = (table: unknown) => ({
    values: (values: Row) => {
      if (table === outboxEvents) outbox.push(values);
      return {
        onConflictDoNothing: async () => {
          if (table === releaseTickets) store.links.push({ ...values });
        },
        returning: async () => [values],
      };
    },
  });

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ update: updateBuilder, insert: insertBuilder }),
  );

  const db = {
    query: {
      projects: { findFirst: findFirst(store.projects) },
      projectReleases: { findFirst: findFirst(store.releases) },
      tickets: { findFirst: findFirst(store.tickets) },
    },
    select: jest.fn(() => ({ from: selectFrom })),
    update: updateBuilder,
    insert: insertBuilder,
    delete: (table: unknown) => ({
      where: async (where: unknown) => {
        if (table !== releaseTickets) return;
        store.links = store.links.filter((row) => !matches(where, row));
      },
    }),
    transaction,
  } as unknown as Db;

  return { db, store, outbox, transaction };
}

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeAccess(): AccessService {
  return standingAccess(MEMBER_STANDING) as unknown as AccessService;
}

function makeService(store: Store) {
  const fixture = makeDb(store);
  return { ...fixture, svc: new ProjectsReleasesService(fixture.db, makeAccess(), lifecycleAuditDouble()) };
}

describe("ProjectsReleasesService — nested release and ticket lookups bind to the URL project", () => {
  it("updateRelease leaves a same-org release owned by another project untouched and answers 404", async () => {
    const store = makeStore();
    const { svc, transaction } = makeService(store);

    await expect(
      svc.updateRelease(makeU(), PROJECT_A, RELEASE_B, { name: "hijacked", rowVersion: 1, releaseDate: null }),
    ).rejects.toThrow(NotFoundException);
    expect(store.releases.find((row) => row.id === RELEASE_B)?.name).toBe("release-b");
  });

  it("updateRelease updates the release that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(
      svc.updateRelease(makeU(), PROJECT_A, RELEASE_A, { name: "release-a-v2", rowVersion: 1, releaseDate: null }),
    ).resolves.toMatchObject({ id: RELEASE_A, name: "release-a-v2", ticketCount: 1 });
    expect(store.releases.find((row) => row.id === RELEASE_A)?.name).toBe("release-a-v2");
  });

  it("updateRelease counts only the caller's organisation when it reports ticketCount", async () => {
    const store = makeStore();
    store.links.push({ orgId: OTHER_ORG, releaseId: RELEASE_A, ticketId: TICKET_B });
    const { svc } = makeService(store);

    await expect(
      svc.updateRelease(makeU(), PROJECT_A, RELEASE_A, { name: "release-a-v2", rowVersion: 1, releaseDate: null }),
    ).resolves.toMatchObject({ ticketCount: 1 });
  });

  it("updateRelease still emits build.release.published for an in-project release (control)", async () => {
    const store = makeStore();
    const { svc, outbox } = makeService(store);

    await expect(
      svc.updateRelease(makeU(), PROJECT_A, RELEASE_A, { status: "released", rowVersion: 1, releaseDate: null }),
    ).resolves.toMatchObject({ id: RELEASE_A });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: "build.release.published",
      aggregateId: String(RELEASE_A),
      organizationId: ORG,
    });
  });

  it("updateRelease does not emit build.release.published for another project's release", async () => {
    const store = makeStore();
    const { svc, outbox } = makeService(store);

    await expect(
      svc.updateRelease(makeU(), PROJECT_A, RELEASE_B, { status: "released", rowVersion: 1, releaseDate: null }),
    ).rejects.toThrow(NotFoundException);
    expect(outbox).toHaveLength(0);
  });

  it("deleteRelease does not soft-delete a same-org release owned by another project", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(svc.deleteRelease(makeU(), PROJECT_A, RELEASE_B)).rejects.toThrow(
      NotFoundException,
    );
    expect(store.releases.find((row) => row.id === RELEASE_B)?.deletedAt).toBeNull();
  });

  it("deleteRelease soft-deletes the release that belongs to the URL project (control)", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(svc.deleteRelease(makeU(), PROJECT_A, RELEASE_A)).resolves.toEqual({
      success: true,
    });
    expect(store.releases.find((row) => row.id === RELEASE_A)?.deletedAt).toBeInstanceOf(Date);
  });

  it("addTicketToRelease refuses a same-org release owned by another project", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(svc.addTicketToRelease(makeU(), PROJECT_A, RELEASE_B, TICKET_A)).rejects.toThrow(
      new NotFoundException("Release not found").message,
    );
    expect(store.links).toHaveLength(1);
  });

  it("addTicketToRelease refuses a same-org ticket owned by another project", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(svc.addTicketToRelease(makeU(), PROJECT_A, RELEASE_A, TICKET_B)).rejects.toThrow(
      new NotFoundException("Ticket not found").message,
    );
    expect(store.links).toHaveLength(1);
  });

  it("addTicketToRelease links an in-project ticket to an in-project release (control)", async () => {
    const store = makeStore();
    store.links = [];
    const { svc } = makeService(store);

    await expect(svc.addTicketToRelease(makeU(), PROJECT_A, RELEASE_A, TICKET_A)).resolves.toEqual({
      success: true,
    });
    expect(store.links).toEqual([{ orgId: ORG, releaseId: RELEASE_A, ticketId: TICKET_A }]);
  });

  it("removeTicketFromRelease refuses a same-org release owned by another project", async () => {
    const store = makeStore();
    store.links.push({ orgId: ORG, releaseId: RELEASE_B, ticketId: TICKET_B });
    const { svc } = makeService(store);

    await expect(
      svc.removeTicketFromRelease(makeU(), PROJECT_A, RELEASE_B, TICKET_B),
    ).rejects.toThrow(new NotFoundException("Release not found").message);
    expect(
      store.links.some((row) => row.releaseId === RELEASE_B && row.ticketId === TICKET_B),
    ).toBe(true);
  });

  it("removeTicketFromRelease unlinks an in-project ticket from an in-project release (control)", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    await expect(
      svc.removeTicketFromRelease(makeU(), PROJECT_A, RELEASE_A, TICKET_A),
    ).resolves.toEqual({ success: true });
    expect(store.links).toHaveLength(0);
  });

  it("removeTicketFromRelease deletes only the caller's organisation link row", async () => {
    const store = makeStore();
    store.links.push({ orgId: OTHER_ORG, releaseId: RELEASE_A, ticketId: TICKET_A });
    const { svc } = makeService(store);

    await expect(
      svc.removeTicketFromRelease(makeU(), PROJECT_A, RELEASE_A, TICKET_A),
    ).resolves.toEqual({ success: true });
    expect(store.links).toEqual([{ orgId: OTHER_ORG, releaseId: RELEASE_A, ticketId: TICKET_A }]);
  });
});
