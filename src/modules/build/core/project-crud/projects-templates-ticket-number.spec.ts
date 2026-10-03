import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTemplatesService } from "./projects-templates.service";
import type { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { BuildTicketCreationService } from "../tickets/build-ticket-creation.service";
import { resolveOrganizationActorsByUserIds } from "../../../../common/organization/organization-actor";

jest.mock("../../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn(),
}));

jest.mock("../lib/build-ticket-capacity", () => ({
  reserveTicketCapacity: jest.fn().mockResolvedValue(undefined),
}));

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function sqlText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  return Object.values(value as Record<string, unknown>)
    .map((child) => sqlText(child, seen))
    .join(" ");
}

const OWNER_ORG = "org-owner";
const OTHER_ORG = "org-other";
const TEMPLATE_TICKETS = [
  { title: "First", description: null, type: "TASK", priority: "MEDIUM", order: 1 },
  { title: "Second", description: null, type: "TASK", priority: "MEDIUM", order: 2 },
];

function harness(highestTicketNumber: number) {
  const allocationQueries: unknown[] = [];
  const insertedTickets: { ticketNumber: number }[] = [];

  const db: Record<string, unknown> = {
    query: {
      projectTemplates: {
        findFirst: jest.fn().mockResolvedValue({
          id: 5,
          description: "tpl",
          tickets: TEMPLATE_TICKETS,
        }),
      },
    },
    execute: (query: unknown) => {
      if (!sqlText(query).includes("project_ticket_counters")) return Promise.resolve([]);
      allocationQueries.push(query);
      return Promise.resolve([{ start: highestTicketNumber + 1 }]);
    },
    transaction: (run: (tx: unknown) => unknown) => Promise.resolve(run(db)),
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (list.some((r) => (r as { ticketNumber?: number }).ticketNumber !== undefined))
          insertedTickets.push(...(list as { ticketNumber: number }[]));
        return {
          returning: () => Promise.resolve([{ id: 42, orgId: OWNER_ORG }]),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
        };
      },
    }),
  };

  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as unknown as PlanLimitsService;

  jest.mocked(resolveOrganizationActorsByUserIds).mockResolvedValue(
    new Map([["user-1", { membershipId: 9 }]]) as never,
  );

  return {
    service: new ProjectsTemplatesService(
      db as unknown as Db,
      planLimits,
      { log: jest.fn(), logCritical: jest.fn() } as never,
      new BuildTicketCreationService(
        db as unknown as Db,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        { runForTicketEvent: jest.fn() } as never,
        { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
      ),
    ),
    allocationQueries,
    insertedTickets,
  };
}

describe("applyTemplate allocates ticket numbers from the highest issued, not the row count", () => {
  it("scopes the allocation read to the caller's organisation", async () => {
    const h = harness(0);

    await h.service.applyTemplate(OWNER_ORG, "user-1", 5, { name: "Alpha" } as never);

    expect(h.allocationQueries).toHaveLength(1);
    expect(sqlValues(h.allocationQueries[0])).toContain(OWNER_ORG);
    expect(sqlValues(h.allocationQueries[0])).not.toContain(OTHER_ORG);
  });

  it("reads MAX(ticket_number) rather than counting rows, so a gap in the sequence cannot reissue a live number", async () => {
    const h = harness(0);

    await h.service.applyTemplate(OWNER_ORG, "user-1", 5, { name: "Alpha" } as never);

    const projection = sqlText(h.allocationQueries[0]).toUpperCase();
    expect(projection).toContain("MAX");
    expect(projection).toContain("COALESCE");
    expect(projection).not.toMatch(/\bCOUNT\s*\(/);
  });

  it("continues from the highest existing number when the project already holds tickets, instead of restarting inside the live range", async () => {
    const h = harness(7);

    await h.service.applyTemplate(OWNER_ORG, "user-1", 5, { name: "Alpha" } as never);

    expect(h.insertedTickets.map((t) => t.ticketNumber)).toEqual([8, 9]);
  });

  it("numbers from one on an empty project, so the common path is unchanged", async () => {
    const h = harness(0);

    await h.service.applyTemplate(OWNER_ORG, "user-1", 5, { name: "Alpha" } as never);

    expect(h.insertedTickets.map((t) => t.ticketNumber)).toEqual([1, 2]);
  });

  it("is unaffected by a sequence whose highest number exceeds its row count, which is the case a row count gets wrong", async () => {
    const h = harness(120);

    await h.service.applyTemplate(OWNER_ORG, "user-1", 5, { name: "Alpha" } as never);

    expect(h.insertedTickets.map((t) => t.ticketNumber)).toEqual([121, 122]);
  });
});
