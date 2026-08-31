import { RecurringJournalsService } from "./recurring-journals.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

const ORG_ID = "org-1";

function makeTemplate(id: number) {
  return {
    id,
    orgId: ORG_ID,
    name: `Template ${id}`,
    description: null as string | null,
    frequency: "MONTHLY" as const,
    nextRunDate: null as string | null,
    lastRunDate: null as string | null,
    endDate: null as string | null,
    isActive: true,
    lines: [],
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildService(rows: ReturnType<typeof makeTemplate>[]): RecurringJournalsService {
  const limit = jest.fn().mockImplementation((n: number) => Promise.resolve(rows.slice(0, n)));
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const db = {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
  } as unknown as Db;
  return new RecurringJournalsService(db, {} as unknown as AuditService);
}

describe("recurring journal templates — cursor pagination", () => {
  it("returns items with no further pages when fewer rows than limit", async () => {
    const svc = buildService([makeTemplate(1), makeTemplate(2)]);

    const result = await svc.listTemplates(ORG_ID, undefined, 50);

    expect(result.data).toHaveLength(2);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("reports more pages when total exceeds page size", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => makeTemplate(i + 1));
    const svc = buildService(rows);

    const result = await svc.listTemplates(ORG_ID, undefined, 10);

    expect(result.data).toHaveLength(10);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();
  });

  it("returns empty items on no rows", async () => {
    const svc = buildService([]);

    const result = await svc.listTemplates(ORG_ID, undefined, 50);

    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
  });
});
