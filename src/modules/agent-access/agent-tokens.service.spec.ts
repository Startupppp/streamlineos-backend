import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AgentTokensService } from "./agent-tokens.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const USER_ID = "user-1";
const ORG_ID = "org-1";

describe("AgentTokensService", () => {
  let svc: AgentTokensService;
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    query: { agentTokens: { findFirst: jest.Mock } };
  };

  function _makeSelectChain(rows: unknown[]) {
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      }),
    };
  }

  function makeCountChain(total: number) {
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ total }]),
      }),
    };
  }

  function makeInsertChain(row: unknown) {
    return {
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([row]),
      }),
    };
  }

  function makeUpdateChain() {
    return {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    };
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      query: { agentTokens: { findFirst: jest.fn() } },
    };

    const module = await Test.createTestingModule({
      providers: [
        AgentTokensService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    svc = module.get(AgentTokensService);
  });

  describe("create", () => {
    it("creates a token and returns the full raw token once", async () => {
      mockDb.select.mockReturnValue(makeCountChain(0));
      const returned = { id: 1, name: "ci-bot", tokenPrefix: "slos_abcd", expiresAt: null, createdAt: new Date() };
      mockDb.insert.mockReturnValue(makeInsertChain(returned));

      const result = await svc.create(USER_ID, ORG_ID, { name: "ci-bot" });
      expect(result.token).toMatch(/^slos_/);
      expect(result.tokenPrefix).toBe("slos_abcd");
    });

    it("throws ConflictException when 10 active tokens already exist", async () => {
      mockDb.select.mockReturnValue(makeCountChain(10));
      await expect(svc.create(USER_ID, ORG_ID, { name: "new-bot" })).rejects.toBeInstanceOf(ConflictException);
    });

    it("allows creation when exactly 9 active tokens exist", async () => {
      mockDb.select.mockReturnValue(makeCountChain(9));
      const returned = { id: 2, name: "bot2", tokenPrefix: "slos_xxxx", expiresAt: null, createdAt: new Date() };
      mockDb.insert.mockReturnValue(makeInsertChain(returned));
      const result = await svc.create(USER_ID, ORG_ID, { name: "bot2" });
      expect(result.token).toMatch(/^slos_/);
    });
  });

  describe("revoke", () => {
    it("sets revokedAt on own token", async () => {
      mockDb.query.agentTokens.findFirst.mockResolvedValue({ id: 5 });
      mockDb.update.mockReturnValue(makeUpdateChain());
      await expect(svc.revoke(USER_ID, ORG_ID, 5)).resolves.toBeUndefined();
    });

    it("throws NotFoundException when token belongs to another user (findFirst returns null)", async () => {
      mockDb.query.agentTokens.findFirst.mockResolvedValue(null);
      await expect(svc.revoke(USER_ID, ORG_ID, 99)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws NotFoundException when token belongs to another org", async () => {
      mockDb.query.agentTokens.findFirst.mockResolvedValue(null);
      await expect(svc.revoke("other-user", "other-org", 5)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
