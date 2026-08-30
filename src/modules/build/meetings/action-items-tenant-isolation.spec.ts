import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ActionItemsService } from "./action-items.service";

describe("ActionItemsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;

  it("throws NotFoundException when meeting not found for different org (cross-tenant isolation)", async () => {
    const db = {
      query: {
        projectMeetings: { findFirst: jest.fn().mockResolvedValue(null) },
        meetingActionItems: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const svc = new ActionItemsService(db, audit);
    await expect(svc.updateItem(ATTACKER_ORG, "u1", 1, 99, 1, { title: "hack" } as never)).rejects.toThrow(NotFoundException);
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
    } as unknown as Db;
    const svc = new ActionItemsService(db, audit);
    const result = await svc.updateItem(OWNER_ORG, "u1", 1, 1, 1, { title: "Updated" } as never);
    expect(result).toBeDefined();
  });
});
