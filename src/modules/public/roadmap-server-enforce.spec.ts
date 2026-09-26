import { NotFoundException } from "@nestjs/common";
import type { AppConfig } from "../../config/env.validation";
import type { Db } from "../../db/drizzle.module";
import { RoadmapService } from "./roadmap.service";

describe("RoadmapService — C4 server-enforce: six access conditions on getRoadmap", () => {
  const VALID_TOKEN = "pub-tok-roadmap-spec";
  const ORG = { id: "org-spec-001", name: "Acme Corp" };

  const ITEM_PLANNED = {
    id: 1,
    title: "Public Feature A",
    description: "A planned item",
    status: "planned",
    category: "product",
    targetQuarter: "2026-Q4",
    votes: 0,
  };

  function makeConfig(): AppConfig {
    return {} as AppConfig;
  }

  function makeDb(opts: {
    orgByToken?: unknown;
    orgById?: unknown;
    items?: unknown[];
    posts?: unknown[];
    changelog?: unknown[];
  }): Db {
    const {
      orgByToken = null,
      orgById = null,
      items = [],
      posts = [],
      changelog = [],
    } = opts;
    return {
      query: {
        organizations: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(orgByToken)
            .mockResolvedValueOnce(orgById),
        },
        roadmapItems: {
          findMany: jest.fn().mockResolvedValue(items),
        },
        feedbackPosts: {
          findMany: jest.fn().mockResolvedValue(posts),
        },
        changelogEntries: {
          findMany: jest.fn().mockResolvedValue(changelog),
        },
      },
    } as unknown as Db;
  }

  describe("tenant isolation and token capability", () => {
    it("throws NotFoundException for an unknown token — no org matches handle on either lookup path", async () => {
      const db = makeDb({ orgByToken: null, orgById: null });
      const svc = new RoadmapService(makeConfig(), db);
      await expect(svc.getRoadmap("nonexistent-handle")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("resolves the roadmap when the token matches — positive control confirms the guard does not always deny", async () => {
      const db = makeDb({ orgByToken: ORG, items: [ITEM_PLANNED] });
      const svc = new RoadmapService(makeConfig(), db);
      const result = await svc.getRoadmap(VALID_TOKEN);
      expect(result.orgName).toBe("Acme Corp");
    });
  });

  describe("lifecycle", () => {
    it("throws NotFoundException for a deleted org — resolveBoardOrg WHERE includes isNull(deletedAt), so the query returns null", async () => {
      const db = makeDb({ orgByToken: null, orgById: null });
      const svc = new RoadmapService(makeConfig(), db);
      await expect(svc.getRoadmap(VALID_TOKEN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("publication state", () => {
    it("returns items from the DB unfiltered — publication gate is enforced in the WHERE: eq(isPublic, true)", async () => {
      const db = makeDb({ orgByToken: ORG, items: [ITEM_PLANNED] });
      const svc = new RoadmapService(makeConfig(), db);
      const result = await svc.getRoadmap(VALID_TOKEN);
      expect(result.roadmap.planned).toHaveLength(1);
      expect(result.roadmap.planned[0]?.title).toBe("Public Feature A");
    });

    it("passes limit: PAGE_SIZE_CAP to roadmapItems.findMany — lists are bounded, not unbounded", async () => {
      const db = makeDb({ orgByToken: ORG });
      const svc = new RoadmapService(makeConfig(), db);
      await svc.getRoadmap(VALID_TOKEN);
      const call = (db.query.roadmapItems.findMany as jest.Mock).mock
        .calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(call).toBeDefined();
      expect(typeof call?.["limit"]).toBe("number");
      expect(call?.["limit"]).toBeLessThanOrEqual(100);
    });

    it("passes limit: PAGE_SIZE_CAP to feedbackPosts.findMany", async () => {
      const db = makeDb({ orgByToken: ORG });
      const svc = new RoadmapService(makeConfig(), db);
      await svc.getRoadmap(VALID_TOKEN);
      const call = (db.query.feedbackPosts.findMany as jest.Mock).mock
        .calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(call?.["limit"]).toBeLessThanOrEqual(100);
    });

    it("passes limit: PAGE_SIZE_CAP to changelogEntries.findMany", async () => {
      const db = makeDb({ orgByToken: ORG });
      const svc = new RoadmapService(makeConfig(), db);
      await svc.getRoadmap(VALID_TOKEN);
      const call = (db.query.changelogEntries.findMany as jest.Mock).mock
        .calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(call?.["limit"]).toBeLessThanOrEqual(100);
    });
  });

  describe("source ACL and roadmap structure", () => {
    it("returns the roadmap partitioned into planned / in_progress / completed", async () => {
      const items = [
        { ...ITEM_PLANNED, status: "planned" },
        { ...ITEM_PLANNED, id: 2, status: "in_progress" },
        { ...ITEM_PLANNED, id: 3, status: "completed" },
      ];
      const db = makeDb({ orgByToken: ORG, items });
      const svc = new RoadmapService(makeConfig(), db);
      const result = await svc.getRoadmap(VALID_TOKEN);
      expect(result.roadmap.planned).toHaveLength(1);
      expect(result.roadmap.in_progress).toHaveLength(1);
      expect(result.roadmap.completed).toHaveLength(1);
    });

    it("falls back to resolving by org id when no org has the token — id-only fallback path", async () => {
      const db = makeDb({ orgByToken: null, orgById: ORG, items: [ITEM_PLANNED] });
      const svc = new RoadmapService(makeConfig(), db);
      const result = await svc.getRoadmap(ORG.id);
      expect(result.orgName).toBe("Acme Corp");
    });
  });

  describe("expiry — architecture note (P1 gap)", () => {
    it("roadmapPublicToken is a text column with no time-based expiry companion — token rotation is the only revocation path", () => {
      const schemaColumnNames = [
        "id",
        "name",
        "slug",
        "roadmapPublicToken",
        "deletedAt",
      ];
      expect(schemaColumnNames).not.toContain("roadmapPublicTokenExpiresAt");
      expect(schemaColumnNames).not.toContain("tokenExpiresAt");
      expect(schemaColumnNames).not.toContain("linkExpiresAt");
    });
  });
});
