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
import { lifecycleAuditDouble } from "../../lifecycle/audit-double";

const ORG = "org-pub-1";
const MEMBERSHIP_ID = 5;
const PROJECT_ID = 10;
const RELEASE_DRAFT = 100;
const RELEASE_RELEASED = 101;
const KNOWN_PUBLISHED_AT = new Date("2026-08-01T09:00:00Z");

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
        rowVersion: 1,
        createdBy: "user-5",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      {
        id: RELEASE_RELEASED,
        orgId: ORG,
        projectId: PROJECT_ID,
        name: "already-released",
        version: "0.9.0",
        description: null,
        status: "released",
        releaseDate: null,
        publishedAt: KNOWN_PUBLISHED_AT,
        rowVersion: 2,
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
    sessionId: "session-pub-1",
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
  return { ...fixture, svc: new ProjectsReleasesService(fixture.db, makeAccess(), lifecycleAuditDouble()) };
}

describe("ProjectsReleasesService — publishedAt writer", () => {
  it("transitioning a draft release to released sets publishedAt in the same transaction, giving the publication a durable timestamp", async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const before = Date.now();

    const result = await svc.updateRelease(makeU(), PROJECT_ID, RELEASE_DRAFT, {
      status: "released",
      rowVersion: 1,
      releaseDate: null,
    });

    expect(result.publishedAt).toBeInstanceOf(Date);
    expect((result.publishedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(store.releases.find((r) => r.id === RELEASE_DRAFT)?.publishedAt).toBeInstanceOf(Date);
  });

  it("updating an already-released release a second time does not move publishedAt, because rewriting it would falsify the historical publication date", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const result = await svc.updateRelease(makeU(), PROJECT_ID, RELEASE_RELEASED, {
      name: "already-released-renamed",
      status: "released",
      rowVersion: 2,
      releaseDate: null,
    });

    expect(result.publishedAt).toEqual(KNOWN_PUBLISHED_AT);
    expect(store.releases.find((r) => r.id === RELEASE_RELEASED)?.publishedAt).toEqual(KNOWN_PUBLISHED_AT);
  });

  it("transitioning a released release back to draft does not clear publishedAt, because it was in fact published once", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const result = await svc.updateRelease(makeU(), PROJECT_ID, RELEASE_RELEASED, {
      status: "draft",
      rowVersion: 2,
      releaseDate: null,
    });

    expect(result.publishedAt).toEqual(KNOWN_PUBLISHED_AT);
    expect(store.releases.find((r) => r.id === RELEASE_RELEASED)?.publishedAt).toEqual(KNOWN_PUBLISHED_AT);
  });

  it("updating a draft release without changing status does not set publishedAt, so a draft always has publishedAt null until it is first released", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const result = await svc.updateRelease(makeU(), PROJECT_ID, RELEASE_DRAFT, {
      name: "draft-release-renamed",
      rowVersion: 1,
      releaseDate: null,
    });

    expect(result.publishedAt).toBeNull();
    expect(store.releases.find((r) => r.id === RELEASE_DRAFT)?.publishedAt).toBeNull();
  });
});
