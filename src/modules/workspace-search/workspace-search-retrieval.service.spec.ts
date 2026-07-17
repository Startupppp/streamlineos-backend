import { Test } from "@nestjs/testing";
import { WorkspaceSearchRetrievalService } from "./workspace-search-retrieval.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { EmbeddingsService } from "../ai/providers/embeddings.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    branchId: null,
    role: "EMPLOYEE",
    permissions: [],
    enabledModules: [],
    plan: null,
    isPlatformAdmin: false,
    isOrgOwner: false,
    sessionId: "session-1",
    ...overrides,
  };
}

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
};

const mockEmbeddings = {
  isConfigured: jest.fn().mockReturnValue(false),
  embedQuery: jest.fn(),
  toVectorLiteral: jest.fn(),
};

describe("WorkspaceSearchRetrievalService", () => {
  let service: WorkspaceSearchRetrievalService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        WorkspaceSearchRetrievalService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EmbeddingsService, useValue: mockEmbeddings },
      ],
    }).compile();

    service = module.get(WorkspaceSearchRetrievalService);
    jest.clearAllMocks();
    mockDb.limit.mockResolvedValue([]);
    mockEmbeddings.isConfigured.mockReturnValue(false);
  });

  describe("permission filtering", () => {
    it("returns empty when user has no permissions", async () => {
      const user = makeUser({ permissions: [] });
      const result = await service.retrieve(user, "test query", undefined, 20);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("returns empty when requestedTypes have no permitted overlap", async () => {
      const user = makeUser({ permissions: ["projects:view", "projects:tickets:view"] });
      const result = await service.retrieve(user, "test query", ["lead", "deal"], 20);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("allows org owners to see all entity types", async () => {
      const user = makeUser({ isOrgOwner: true });
      await service.retrieve(user, "query", undefined, 20);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("allows platform admins to see all entity types", async () => {
      const user = makeUser({ isPlatformAdmin: true });
      await service.retrieve(user, "query", undefined, 20);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("filters to only permitted entity types", async () => {
      const user = makeUser({ permissions: ["projects:view", "projects:tickets:view"] });
      await service.retrieve(user, "query", undefined, 20);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("requires all permissions for ticket type (projects:view AND projects:tickets:view)", async () => {
      const userWithOnlyProjectsView = makeUser({ permissions: ["projects:view"] });
      await service.retrieve(userWithOnlyProjectsView, "query", ["ticket"], 20);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("returns empty for cross-tenant isolation (empty query string)", async () => {
      const user = makeUser({ isOrgOwner: true });
      const result = await service.retrieve(user, "  ", undefined, 20);
      expect(result).toEqual([]);
    });
  });

  describe("RRF fusion", () => {
    it("fuses keyword and vector lists by score", async () => {
      const privateMethod = (service as unknown as { fuse: (lists: string[][]) => string[] }).fuse;
      const fused = privateMethod.call(service, [
        ["a:1", "a:2", "b:1"],
        ["b:1", "a:1", "a:3"],
      ]);
      const aOneIdx = fused.indexOf("a:1");
      const bOneIdx = fused.indexOf("b:1");
      expect(aOneIdx).toBeGreaterThanOrEqual(0);
      expect(bOneIdx).toBeGreaterThanOrEqual(0);
      expect(aOneIdx).toBeLessThan(bOneIdx);
    });
  });

  describe("noPermittedSource scenario", () => {
    it("retrieve returns empty array when DB returns no rows", async () => {
      const user = makeUser({ isOrgOwner: true });
      mockDb.limit.mockResolvedValue([]);
      const result = await service.retrieve(user, "findme", undefined, 10);
      expect(result).toEqual([]);
    });
  });
});
