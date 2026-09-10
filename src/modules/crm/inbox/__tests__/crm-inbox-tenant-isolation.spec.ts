import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { CrmInboxService } from "../crm-inbox.service";
import type { CrmInboxQueriesService } from "../crm-inbox-queries.service";
import { ScopedRead } from "../../../access/scoped-read";

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

function makeSelectDb(rows: unknown[] = []): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  } as unknown as Db;
  return { db, where };
}

function makeQueriesDep(): CrmInboxQueriesService {
  return {
    getInbox: jest.fn().mockResolvedValue({ tasks: [], leads: [], contacts: [], deals: [] }),
    getCounts: jest.fn().mockResolvedValue({ tasks: 0, leads: 0, contacts: 0, deals: 0 }),
  } as unknown as CrmInboxQueriesService;
}

const ATTACKER_ORG = "org-attacker-crm-inbox";
const VICTIM_ORG = "org-victim-crm-inbox";

const readAs = (orgId: string) => ScopedRead.of(orgId, "user-x", "all");

describe("CrmInboxService — cross-tenant isolation", () => {
  it("snoozeTask throws NotFoundException when task not found in the requesting org (cross-tenant probe = 404 not 403)", async () => {
    const { db } = makeSelectDb([]);
    const svc = new CrmInboxService(db, makeQueriesDep());

    await expect(
      svc.snoozeTask(readAs(ATTACKER_ORG), 999, { until: new Date(Date.now() + 60_000).toISOString() }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("snoozeTask scopes the SELECT to the requesting org — WHERE clause contains orgId for tenant isolation", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmInboxService(db, makeQueriesDep());

    await expect(
      svc.snoozeTask(readAs(ATTACKER_ORG), 42, { until: new Date(Date.now() + 60_000).toISOString() }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("completeTask throws NotFoundException for a task that does not belong to the requesting org (different org isolation)", async () => {
    const { db } = makeSelectDb([]);
    const svc = new CrmInboxService(db, makeQueriesDep());

    await expect(
      svc.completeTask(readAs(ATTACKER_ORG), 777),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("completeTask WHERE clause binds to requesting org — cross-tenant caller cannot see victim org task", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new CrmInboxService(db, makeQueriesDep());

    await expect(
      svc.completeTask(readAs(ATTACKER_ORG), 55),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });
});
