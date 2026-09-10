import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AgentTokensService, AGENT_TOKEN_DEFAULT_CEILING } from "./agent-tokens.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import type { DataScope } from "../access/access.types";

const USER_ID = "user-1";
const ORG_ID = "org-1";

describe("AgentTokensService", () => {
  let svc: AgentTokensService;
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    query: {
      agentTokens: { findFirst: jest.Mock };
      organizationMembers: { findFirst: jest.Mock };
    };
  };
  let resolveUserPermissions: jest.Mock;
  let auditLog: jest.Mock;

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
      query: {
        agentTokens: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      },
    };

    const issuerHolds = new Map<string, DataScope>(
      AGENT_TOKEN_DEFAULT_CEILING.map((key) => [key, "all" as DataScope]),
    );
    resolveUserPermissions = jest.fn().mockResolvedValue(issuerHolds);
    auditLog = jest.fn();

    const module = await Test.createTestingModule({
      providers: [
        AgentTokensService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: { resolveUserPermissions } },
        { provide: AuditService, useValue: { log: auditLog } },
      ],
    }).compile();
    svc = module.get(AgentTokensService);
  });

  describe("create", () => {
    it("creates a token and returns the full raw token once", async () => {
      mockDb.select.mockReturnValue(makeCountChain(0));
      const returned = { id: 1, name: "ci-bot", tokenPrefix: "slos_abcd", scopes: [...AGENT_TOKEN_DEFAULT_CEILING], expiresAt: null, createdAt: new Date() };
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
      const returned = { id: 2, name: "bot2", tokenPrefix: "slos_xxxx", scopes: [...AGENT_TOKEN_DEFAULT_CEILING], expiresAt: null, createdAt: new Date() };
      mockDb.insert.mockReturnValue(makeInsertChain(returned));
      const result = await svc.create(USER_ID, ORG_ID, { name: "bot2" });
      expect(result.token).toMatch(/^slos_/);
    });
  });

  describe("the ceiling is bounded by what the issuer holds", () => {
    it("refuses a scope the issuer does not hold", async () => {
      mockDb.select.mockReturnValue(makeCountChain(0));

      await expect(
        svc.create(USER_ID, ORG_ID, {
          name: "over-reaching",
          scopes: ["hr:employees:view"],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("stores only the requested scopes the issuer holds", async () => {
      mockDb.select.mockReturnValue(makeCountChain(0));
      const returned = {
        id: 3,
        name: "narrow",
        tokenPrefix: "slos_narr",
        scopes: ["build:tickets:view"],
        expiresAt: null,
        createdAt: new Date(),
      };
      const insertChain = makeInsertChain(returned);
      mockDb.insert.mockReturnValue(insertChain);

      await svc.create(USER_ID, ORG_ID, {
        name: "narrow",
        scopes: ["build:tickets:view"],
      });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          issuerMembershipId: 7,
          scopes: ["build:tickets:view"],
        }),
      );
    });

    it("defaults to the agent surface intersected with what the issuer holds", async () => {
      mockDb.select.mockReturnValue(makeCountChain(0));
      resolveUserPermissions.mockResolvedValue(
        new Map<string, DataScope>([["build:tickets:view", "all"]]),
      );
      const insertChain = makeInsertChain({
        id: 4,
        name: "d",
        tokenPrefix: "slos_dddd",
        scopes: ["build:tickets:view"],
        expiresAt: null,
        createdAt: new Date(),
      });
      mockDb.insert.mockReturnValue(insertChain);

      await svc.create(USER_ID, ORG_ID, { name: "d" });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: ["build:tickets:view"] }),
      );
    });

    it("refuses an issuer with no active membership", async () => {
      mockDb.query.organizationMembers.findFirst.mockResolvedValue(undefined);

      await expect(
        svc.create(USER_ID, ORG_ID, { name: "orphan" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("revoke", () => {
    it("sets revokedAt on own token", async () => {
      mockDb.query.agentTokens.findFirst.mockResolvedValue({ id: 5, issuerMembershipId: 7, tokenPrefix: "slos_abcd" });
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
