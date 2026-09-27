import { ConflictException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import { GoalLinksService } from "./goal-links.service";

describe("GoalLinksService.createLink constraint violations", () => {
  const orgId = "org-1";
  const goalId = 5;

  function createService(insertError: Error) {
    const db = {
      query: {
        okrGoals: { findFirst: jest.fn().mockResolvedValue({ id: goalId }) },
        tickets: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(insertError),
        }),
      }),
    };
    return new GoalLinksService(db as never);
  }

  it("answers 409 when the database rejects a row that violates the exclusive-arc check constraint", async () => {
    const service = createService(drizzlePostgresError("23514", "chk_okr_links_exclusive_arc"));
    await expect(
      service.createLink(orgId, goalId, { ticketId: 10 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("answers 409 when the same ticket is already linked to the goal", async () => {
    const service = createService(drizzleUniqueViolation("uniq_okr_links_goal_ticket"));
    await expect(
      service.createLink(orgId, goalId, { ticketId: 10 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("answers 409 when the same project is already linked to the goal", async () => {
    const service = createService(drizzleUniqueViolation("uniq_okr_links_goal_project"));
    await expect(
      service.createLink(orgId, goalId, { projectId: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_okr_links_org_goal");
    const service = createService(fkViolation);
    await expect(
      service.createLink(orgId, goalId, { ticketId: 10 }),
    ).rejects.toBe(fkViolation);
  });
});
