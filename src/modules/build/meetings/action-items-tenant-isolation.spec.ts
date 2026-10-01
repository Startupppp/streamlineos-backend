import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { BuildTicketCreationService } from "../core/tickets";
import { ActionItemsService } from "./action-items.service";
import { createActionItemSchema, updateActionItemSchema } from "./dto/meetings.schemas";
import { MEMBER_STANDING, projectAccessRow, principalAccess } from "../core/project-crud/__tests__/project-access-doubles";

const projectSelect = () => ({ from: () => ({ where: () => ({ limit: async () => [projectAccessRow()] }) }) });

describe("createActionItemSchema — strict() rejects status field sent by frontend in BUG-049", () => {
  it("rejects a payload that includes status because create schema has no status key and .strict() disallows extras", () => {
    const result = createActionItemSchema.safeParse({
      title: "Review PR",
      status: "open",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid create payload without status confirming the create path still succeeds after frontend fix", () => {
    const result = createActionItemSchema.safeParse({ title: "Review PR" });
    expect(result.success).toBe(true);
  });
});

describe("ActionItemsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function owner(orgId: string): CurrentUserContext {
    return {
      userId: "u1",
      orgId,
      role: "OWNER",
      isOrgOwner: true,
      sessionId: "s",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, true),
    };
  }

  async function service(db: object): Promise<ActionItemsService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ActionItemsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: BuildTicketCreationService, useValue: {} },
        { provide: AccessService, useValue: principalAccess(MEMBER_STANDING) },
      ],
    }).compile();
    return moduleRef.get(ActionItemsService);
  }

  it("throws NotFoundException when meeting not found for different org (cross-tenant isolation)", async () => {
    const db = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(null) },
        meetingActionItems: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: projectSelect,
    };
    const svc = await service(db);
    await expect(
      svc.updateItem(owner(ATTACKER_ORG), 1, 99, 1, updateActionItemSchema.parse({ title: "hack" })),
    ).rejects.toThrow(NotFoundException);
  });

  it("returns item for the owning org (same-tenant control)", async () => {
    const meeting = { id: 1, orgId: OWNER_ORG, projectId: 1 };
    const item = { id: 1, orgId: OWNER_ORG, meetingId: 1, title: "Task" };
    const returning = jest.fn().mockResolvedValue([item]);
    const update = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }) });
    const db = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(meeting) },
        meetingActionItems: { findFirst: jest.fn().mockResolvedValue(item) },
      },
      update,
      select: projectSelect,
    };
    const svc = await service(db);
    const result = await svc.updateItem(owner(OWNER_ORG), 1, 1, 1, updateActionItemSchema.parse({ title: "Updated" }));
    expect(result).toBeDefined();
  });
});
