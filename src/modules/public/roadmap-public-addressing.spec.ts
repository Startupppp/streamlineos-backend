import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AppConfig } from "../../config/env.validation";
import { stubService } from "../../test/service-stub.spec-fixtures";
import { RoadmapService } from "./roadmap.service";

const ORG_ID = "org_live_9812";
const ORG_SLUG = "acme-corp";
const PUBLICATION_TOKEN = "rm_9fK2xQ7vBnL4tR8sW1yZ3aC6";

function chunksOf(node: unknown): unknown[] | null {
  if (node === null || typeof node !== "object") return null;
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  return Array.isArray(chunks) ? chunks : null;
}

function columnNames(node: unknown, out: string[] = []): string[] {
  const chunks = chunksOf(node);
  if (chunks !== null) {
    for (const chunk of chunks) columnNames(chunk, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const candidate = node as { name?: unknown; table?: unknown };
  if (typeof candidate.name === "string" && candidate.table !== undefined) out.push(candidate.name);
  return out;
}

function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  const chunks = chunksOf(node);
  if (chunks !== null) {
    for (const chunk of chunks) boundValues(chunk, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  if (Object.prototype.hasOwnProperty.call(node, "value")) out.push((node as { value: unknown }).value);
  return out;
}

function config(): AppConfig {
  return stubService<AppConfig>({ VOTE_IP_SALT: "salt", BACKEND_JWT_SECRET: "secret" });
}

interface Harness {
  db: Db;
  orgLookups: () => unknown[];
  ticketLookups: () => unknown[];
  insertedValues: () => unknown[];
}

function makeHarness(resolvesTo: { id: string; name: string } | null, options?: { itemFound?: boolean }): Harness {
  const orgWhere: unknown[] = [];
  const ticketWhere: unknown[] = [];
  const inserted: unknown[] = [];

  const organizationsFindFirst = jest.fn((args: { where?: unknown }) => {
    orgWhere.push(args.where);
    if (resolvesTo === null) return Promise.resolve(undefined);
    const targetsToken = columnNames(args.where).includes("roadmap_public_token");
    const values = boundValues(args.where);
    const matched = targetsToken
      ? values.includes(PUBLICATION_TOKEN)
      : values.includes(ORG_ID);
    return Promise.resolve(matched ? resolvesTo : undefined);
  });

  const db = {
    query: {
      organizations: { findFirst: organizationsFindFirst },
      roadmapItems: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn((args: { where?: unknown }) => {
          ticketWhere.push(args.where);
          return Promise.resolve(options?.itemFound === true ? { id: 1 } : undefined);
        }),
      },
      feedbackPosts: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(undefined) },
      changelogEntries: { findMany: jest.fn().mockResolvedValue([]) },
    },
    insert: jest.fn(() => ({
      values: jest.fn((payload: unknown) => {
        inserted.push(payload);
        return { returning: jest.fn().mockResolvedValue([{ id: 7 }]) };
      }),
    })),
  } as unknown as Db;

  return {
    db,
    orgLookups: () => orgWhere,
    ticketLookups: () => ticketWhere,
    insertedValues: () => inserted,
  };
}

describe("RoadmapService — opaque public board addressing", () => {
  const org = { id: ORG_ID, name: "Acme Corp" };

  it("resolves a board from its opaque publication token", async () => {
    const h = makeHarness(org);
    const board = await new RoadmapService(config(), h.db).getRoadmap(PUBLICATION_TOKEN);
    expect(board.orgName).toBe("Acme Corp");
  });

  it("still resolves a board from the organization id so links already shared keep working", async () => {
    const h = makeHarness(org);
    const board = await new RoadmapService(config(), h.db).getRoadmap(ORG_ID);
    expect(board.orgName).toBe("Acme Corp");
  });

  it("never queries the organization slug column, so a guessable slug is not a board address", async () => {
    const h = makeHarness(org);
    await expect(new RoadmapService(config(), h.db).getRoadmap(ORG_SLUG)).rejects.toThrow(NotFoundException);
    const queried = h.orgLookups().flatMap((where) => columnNames(where));
    expect(queried).toContain("roadmap_public_token");
    expect(queried).toContain("id");
    expect(queried).not.toContain("slug");
  });

  it("filters soft-deleted organizations out of every board lookup", async () => {
    const h = makeHarness(org);
    await new RoadmapService(config(), h.db).getRoadmap(PUBLICATION_TOKEN);
    for (const where of h.orgLookups()) {
      expect(columnNames(where)).toContain("deleted_at");
    }
  });

  it("does not expose the resolved organization identifier in the public board payload", async () => {
    const h = makeHarness(org);
    const board = await new RoadmapService(config(), h.db).getRoadmap(PUBLICATION_TOKEN);
    expect(JSON.stringify(board)).not.toContain(ORG_ID);
    expect(JSON.stringify(board)).not.toContain(ORG_SLUG);
  });
});

describe("RoadmapService — writes resolve the handle the same way the board read does", () => {
  const org = { id: ORG_ID, name: "Acme Corp" };

  it("scopes a vote to the resolved organization id rather than the token from the URL", async () => {
    const h = makeHarness(org, { itemFound: false });
    const svc = new RoadmapService(config(), h.db);
    await expect(
      svc.vote(PUBLICATION_TOKEN, { type: "roadmap", id: 1, voterKey: "voter" }),
    ).rejects.toThrow(NotFoundException);

    const [where] = h.ticketLookups();
    expect(boundValues(where)).toContain(ORG_ID);
    expect(boundValues(where)).not.toContain(PUBLICATION_TOKEN);
  });

  it("rejects a vote against a handle that addresses no board", async () => {
    const h = makeHarness(null);
    const svc = new RoadmapService(config(), h.db);
    await expect(
      svc.vote(ORG_SLUG, { type: "roadmap", id: 1, voterKey: "voter" }),
    ).rejects.toThrow(NotFoundException);
    expect(h.ticketLookups()).toHaveLength(0);
  });

  it("stores submitted feedback against the resolved organization id, not the token from the URL", async () => {
    const h = makeHarness(org);
    const svc = new RoadmapService(config(), h.db);
    const result = await svc.submitFeedback(PUBLICATION_TOKEN, { title: "Please add dark mode" });

    expect(result.id).toBe(7);
    const [payload] = h.insertedValues();
    expect(payload).toMatchObject({ orgId: ORG_ID });
  });

  it("rejects feedback submitted against a handle that addresses no board", async () => {
    const h = makeHarness(null);
    const svc = new RoadmapService(config(), h.db);
    await expect(svc.submitFeedback(ORG_SLUG, { title: "Please add dark mode" })).rejects.toThrow(
      NotFoundException,
    );
    expect(h.insertedValues()).toHaveLength(0);
  });
});
