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
  releaseTickets,
  projects,
} from "../../../../db/schema";
import { ProjectsReleasesService } from "./projects-releases.service";

const ORG = "org-rel-scale-1";
const MEMBERSHIP_ID = 5;
const PROJECT_ID = 10;
const RELEASE_DRAFT = 300;
const RELEASE_ROW_VERSION = 7;

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
  links: Row[];
}

function makeStore(): Store {
  return {
    projects: [
      { id: PROJECT_ID, orgId: ORG, managerMembershipId: MEMBERSHIP_ID, deletedAt: null },
    ],
    projectMembers: [{ projectId: PROJECT_ID, orgId: ORG, role: "ADMIN" }],
    releases: [
      {
        id: RELEASE_DRAFT,
        orgId: ORG,
        projectId: PROJECT_ID,
        name: "draft-release",
        version: "1.0.0",
        description: null,
        status: "draft",
        releaseDate: null,
        publishedAt: null,
        rowVersion: RELEASE_ROW_VERSION,
        createdBy: "user-5",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
    ],
    links: [],
  };
}

function makeDb(store: Store): { db: Db; outbox: Row[] } {
  const outbox: Row[] = [];

  const findFirst = (rows: Row[]) =>
    jest.fn(async (args: { where?: unknown }) => rows.find((row) => matches(args.where, row)));

  const selectFrom = (table: unknown) => {
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
        onConflictDoNothing: async () => undefined,
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
    },
    select: jest.fn(() => ({ from: selectFrom })),
    update: updateBuilder,
    insert: insertBuilder,
    delete: () => ({ where: async () => undefined }),
    transaction,
  } as unknown as Db;

  return { db, outbox };
}

function makeU(): CurrentUserContext {
  return {
    userId: "user-5",
    orgId: ORG,
    role: "ADMIN",
    isOrgOwner: false,
    sessionId: "session-rel-scale-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

function makeService(store: Store) {
  const fixture = makeDb(store);
  return { ...fixture, svc: new ProjectsReleasesService(fixture.db, makeAccess()) };
}

describe("ProjectsReleasesService.updateRelease — outbox aggregateVersion scale", () => {
  it("publishing a release emits aggregateVersion at row scale, never the epoch-millisecond scale Date.now() produces", async () => {
    const store = makeStore();
    const { svc, outbox } = makeService(store);
    const beforeEpochMs = Date.now();

    await svc.updateRelease(makeU(), PROJECT_ID, RELEASE_DRAFT, {
      status: "released",
      rowVersion: RELEASE_ROW_VERSION,
    });

    expect(outbox).toHaveLength(1);
    const emitted = outbox[0] as { aggregateVersion: number; aggregateType: string };
    expect(emitted.aggregateType).toBe("release");
    expect(emitted.aggregateVersion).toBe(RELEASE_ROW_VERSION);
    expect(emitted.aggregateVersion).toBeLessThan(1_000_000_000);
    expect(emitted.aggregateVersion).toBeLessThan(beforeEpochMs);
  });
});
