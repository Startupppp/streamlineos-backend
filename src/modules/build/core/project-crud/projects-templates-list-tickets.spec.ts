import type { Db } from "../../../../db/drizzle.module";
import type { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { BuildTicketCreationService } from "../tickets";
import { ProjectsTemplatesService } from "./projects-templates.service";

const FAKE_TEMPLATE = {
  id: 7,
  orgId: "org-1",
  name: "Sprint Setup",
  description: null,
  category: "GENERAL",
  createdBy: "user-1",
  deletedAt: null,
  createdAt: new Date("2026-09-19T10:00:00.000Z"),
};

const FAKE_TICKET = {
  id: 11,
  templateId: 7,
  orgId: "org-1",
  title: "Set up repo",
  description: null,
  type: "TASK",
  priority: "MEDIUM",
  estimatedHours: null,
  order: 0,
  phase: null,
};

function makeMultiSelectDb(sequences: unknown[][]): Db {
  let callIndex = 0;
  return {
    select: jest.fn(() => {
      const rows = sequences[callIndex] ?? [];
      callIndex += 1;
      const builder: Record<string, unknown> = {
        from: jest.fn(() => builder),
        where: jest.fn(() => builder),
        orderBy: jest.fn(() => builder),
        limit: jest.fn(() => Promise.resolve(rows)),
        then: (resolve: (v: unknown) => void, reject: (r: unknown) => void) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return builder;
    }),
  } as unknown as Db;
}

describe("ProjectsTemplatesService.listTemplates — BUG-054: tickets are included in the list response so the template card shows task count after reload", () => {
  it("includes a tickets array on each template row so the card does not show 0 tasks after create and reload", async () => {
    const db = makeMultiSelectDb([[FAKE_TEMPLATE], [FAKE_TICKET]]);
    const svc = new ProjectsTemplatesService(
      db,
      {} as PlanLimitsService,
      { log: jest.fn(), logCritical: jest.fn() } as never,
      { create: jest.fn(), createInTransaction: jest.fn(), publish: jest.fn() } as unknown as BuildTicketCreationService,
    );

    const result = await svc.listTemplates("org-1", {});

    expect(result.data[0]).toHaveProperty("tickets");
    expect(Array.isArray(result.data[0].tickets)).toBe(true);
  });

  it("attaches the correct tickets to their template so a page with two templates does not mix up tasks", async () => {
    const db = makeMultiSelectDb([[FAKE_TEMPLATE], [FAKE_TICKET]]);
    const svc = new ProjectsTemplatesService(
      db,
      {} as PlanLimitsService,
      { log: jest.fn(), logCritical: jest.fn() } as never,
      { create: jest.fn(), createInTransaction: jest.fn(), publish: jest.fn() } as unknown as BuildTicketCreationService,
    );

    const result = await svc.listTemplates("org-1", {});

    expect(result.data[0].tickets).toHaveLength(1);
    expect(result.data[0].tickets?.[0]).toMatchObject({ id: 11, title: "Set up repo" });
  });

  it("returns an empty tickets array for a template that has no tasks rather than omitting the field", async () => {
    const db = makeMultiSelectDb([[FAKE_TEMPLATE], []]);
    const svc = new ProjectsTemplatesService(
      db,
      {} as PlanLimitsService,
      { log: jest.fn(), logCritical: jest.fn() } as never,
      { create: jest.fn(), createInTransaction: jest.fn(), publish: jest.fn() } as unknown as BuildTicketCreationService,
    );

    const result = await svc.listTemplates("org-1", {});

    expect(result.data[0].tickets).toEqual([]);
  });

  it("returns an empty data array without issuing the ticket batch query when the template page is empty", async () => {
    const selectMock = jest.fn();
    const db = { select: selectMock } as unknown as Db;
    const svc = new ProjectsTemplatesService(
      db,
      {} as PlanLimitsService,
      { log: jest.fn(), logCritical: jest.fn() } as never,
      { create: jest.fn(), createInTransaction: jest.fn(), publish: jest.fn() } as unknown as BuildTicketCreationService,
    );

    const builder: Record<string, unknown> = {
      from: jest.fn(() => builder),
      where: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      limit: jest.fn(() => Promise.resolve([])),
    };
    selectMock.mockReturnValue(builder);

    const result = await svc.listTemplates("org-1", {});

    expect(result.data).toHaveLength(0);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
