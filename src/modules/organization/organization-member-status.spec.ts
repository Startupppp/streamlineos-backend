import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OrganizationService } from "./organization.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { SessionsService } from "../sessions/sessions.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-1";
const ACTOR_ID = "actor-1";
const MEMBER_ID = "member-1";

describe("OrganizationService member status guards", () => {
  let svc: OrganizationService;
  const findFirst = jest.fn();
  const revokeAllForUser = jest.fn().mockResolvedValue({ revokedCount: 0 });

  beforeEach(async () => {
    findFirst.mockReset();
    revokeAllForUser.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: DRIZZLE, useValue: { query: { organizationMembers: { findFirst } } } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: SessionsService, useValue: { revokeAllForUser } },
      ],
    }).compile();
    svc = moduleRef.get(OrganizationService);
  });

  describe("suspendMember", () => {
    it("throws NotFound when the member does not exist", async () => {
      findFirst.mockResolvedValue(undefined);
      await expect(svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it("refuses to suspend the organization owner", async () => {
      findFirst.mockResolvedValue({ isOwner: true, status: "ACTIVE" });
      await expect(svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it("rejects an already-suspended member", async () => {
      findFirst.mockResolvedValue({ isOwner: false, status: "SUSPENDED" });
      await expect(svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe("reactivateMember", () => {
    it("throws NotFound when the member does not exist", async () => {
      findFirst.mockResolvedValue(undefined);
      await expect(svc.reactivateMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("rejects reactivating a member who is not suspended", async () => {
      findFirst.mockResolvedValue({ status: "ACTIVE" });
      await expect(svc.reactivateMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
