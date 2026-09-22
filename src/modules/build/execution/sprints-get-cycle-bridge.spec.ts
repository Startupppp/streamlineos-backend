import { NotFoundException } from "@nestjs/common";
import { SprintsService } from "./sprints.service";
import type { Db } from "../../../db/drizzle.module";

const SPRINT_ROW = {
  id: 9,
  orgId: "org-1",
  projectId: 1,
  name: "Sprint 9",
  startDate: new Date("2026-01-01"),
  endDate: new Date("2026-01-14"),
  goal: "ship it",
  status: "ACTIVE",
  deletedAt: null,
};

const TICKET_ROW = {
  id: 100,
  title: "Bridged ticket",
  status: "TODO",
  points: 3,
  cycleId: 55,
  assignee: { user: { id: "user-1", name: "Ann", firstName: "Ann", lastName: "B", image: null, email: "a@b.c" } },
};

function makeHarness(opts: {
  sprint?: unknown;
  cycleRows?: { id: number }[];
  ticketRows?: unknown[];
}) {
  const sprintFindFirst = jest.fn().mockResolvedValue(
    "sprint" in opts ? opts.sprint : SPRINT_ROW,
  );
  const ticketsFindMany = jest.fn().mockResolvedValue(opts.ticketRows ?? [TICKET_ROW]);
  const cycleLimit = jest.fn().mockResolvedValue(opts.cycleRows ?? [{ id: 55 }]);
  const db = {
    query: {
      sprints: { findFirst: sprintFindFirst },
      tickets: { findMany: ticketsFindMany },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: cycleLimit,
    }),
  } as unknown as Db;
  const svc = new SprintsService(db, null);
  return { svc, sprintFindFirst, ticketsFindMany, cycleLimit };
}

describe("SprintsService.getSprint — cycle-keyed ticket load (no tickets.sprint_id traversal)", () => {
  it("never asks the relational API to traverse the sprints-to-tickets relation, which joins on the column phase-04 drops", async () => {
    const { svc, sprintFindFirst } = makeHarness({});
    await svc.getSprint("org-1", 1, 9);
    const args = sprintFindFirst.mock.calls[0][0] as { with?: Record<string, unknown> };
    expect(args.with?.tickets).toBeUndefined();
  });

  it("loads the sprint's tickets by cycleId after bridging the sprint through cycles.legacySprintId", async () => {
    const { svc, ticketsFindMany } = makeHarness({});
    await svc.getSprint("org-1", 1, 9);
    expect(ticketsFindMany).toHaveBeenCalledTimes(1);
    expect((ticketsFindMany.mock.calls[0][0] as { limit: number }).limit).toBe(200);
  });

  it("returns the unchanged response shape: the sprint row plus a tickets array carrying the assignee sub-object", async () => {
    const { svc } = makeHarness({});
    const result = await svc.getSprint("org-1", 1, 9);
    expect(result).toMatchObject({ id: 9, name: "Sprint 9", status: "ACTIVE" });
    expect(result.tickets).toEqual([TICKET_ROW]);
  });

  it("returns the same shape with an empty tickets array when the sprint has no cycle counterpart, rather than throwing", async () => {
    const { svc, ticketsFindMany } = makeHarness({ cycleRows: [] });
    const result = await svc.getSprint("org-1", 1, 9);
    expect(result).toMatchObject({ id: 9, name: "Sprint 9" });
    expect(result.tickets).toEqual([]);
    expect(ticketsFindMany).not.toHaveBeenCalled();
  });

  it("still throws NotFoundException when the sprint row itself is absent", async () => {
    const { svc, cycleLimit } = makeHarness({ sprint: undefined });
    await expect(svc.getSprint("org-1", 1, 999)).rejects.toThrow(NotFoundException);
    expect(cycleLimit).not.toHaveBeenCalled();
  });
});
