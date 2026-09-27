import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.types";
import {
  publishRoadmap,
  readRoadmapPublication,
  rotateRoadmapPublicationToken,
  unpublishRoadmap,
} from "./roadmap-publication";

const ORG_ID = "org_live_9812";

interface Harness {
  db: Db;
  written: () => (string | null)[];
}

function makeDb(storedToken: string | null, options?: { failWith?: unknown }): Harness {
  const written: (string | null)[] = [];

  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue(storedToken === null ? [] : [{ token: storedToken }]),
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((payload: { roadmapPublicToken?: string | null }) => ({
        where: jest.fn(() => {
          if (options?.failWith !== undefined) return Promise.reject(options.failWith);
          written.push(payload.roadmapPublicToken ?? null);
          return Promise.resolve(undefined);
        }),
      })),
    })),
  } as unknown as Db;

  return { db, written: () => written };
}

function uniqueViolationOnTokenIndex(): unknown {
  return new Error("Failed query", {
    cause: { code: "23505", constraint_name: "uq_organizations_roadmap_public_token" },
  });
}

describe("roadmap publication token", () => {
  it("reports an unpublished organization as having no token and no path", async () => {
    const { db } = makeDb(null);
    await expect(readRoadmapPublication(db, ORG_ID)).resolves.toEqual({ token: null, path: null });
  });

  it("exposes the public path derived from the stored token", async () => {
    const { db } = makeDb("rm_existing");
    await expect(readRoadmapPublication(db, ORG_ID)).resolves.toEqual({
      token: "rm_existing",
      path: "/roadmap/rm_existing",
    });
  });

  it("mints a token on first publish", async () => {
    const h = makeDb(null);
    const result = await publishRoadmap(h.db, ORG_ID);
    expect(result.token).toMatch(/^rm_[A-Za-z0-9_-]{32}$/);
    expect(h.written()).toEqual([result.token]);
  });

  it("publishing twice keeps the first token so a shared link never breaks", async () => {
    const h = makeDb("rm_existing");
    const result = await publishRoadmap(h.db, ORG_ID);
    expect(result.token).toBe("rm_existing");
    expect(h.written()).toEqual([]);
  });

  it("mints a token that does not contain the organization identifier", async () => {
    const h = makeDb(null);
    const result = await publishRoadmap(h.db, ORG_ID);
    expect(result.token).not.toContain(ORG_ID);
  });

  it("rotation replaces the stored token so the previous link stops resolving", async () => {
    const h = makeDb("rm_existing");
    const result = await rotateRoadmapPublicationToken(h.db, ORG_ID);
    expect(result.token).not.toBe("rm_existing");
    expect(h.written()).toEqual([result.token]);
  });

  it("two mints never produce the same token", async () => {
    const first = await publishRoadmap(makeDb(null).db, ORG_ID);
    const second = await publishRoadmap(makeDb(null).db, ORG_ID);
    expect(first.token).not.toBe(second.token);
  });

  it("unpublishing clears the token so the public board is no longer addressable", async () => {
    const h = makeDb("rm_existing");
    await unpublishRoadmap(h.db, ORG_ID);
    expect(h.written()).toEqual([null]);
  });

  it("answers a token collision with 409 rather than a 500", async () => {
    const h = makeDb(null, { failWith: uniqueViolationOnTokenIndex() });
    await expect(publishRoadmap(h.db, ORG_ID)).rejects.toThrow(ConflictException);
  });

  it("rethrows a failure that is not a token collision", async () => {
    const h = makeDb(null, { failWith: new Error("connection terminated") });
    await expect(publishRoadmap(h.db, ORG_ID)).rejects.toThrow("connection terminated");
  });
});
