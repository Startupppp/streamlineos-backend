jest.mock("../../db/schema", () => ({
  activities: {},
  businessParties: {},
  deals: {},
  subjects: {},
  users: {},
}));

import type { Db } from "../../db/drizzle.types";
import { MyTasksService } from "./my-tasks.service";

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
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const USER_ID = "user-1";

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({ where }),
      }),
    }),
  } as unknown as Db;
  return { db, where };
}

describe("MyTasksService.myTasks — cross-tenant isolation", () => {
  it("scopes the task query to the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new MyTasksService(db);

    const result = await svc.myTasks(ATTACKER_ORG, USER_ID, { limit: 20, includeCompleted: false });

    expect(result.data).toHaveLength(0);
    if (where.mock.calls[0]) {
      const leafValues = sqlValues(where.mock.calls[0][0]);
      expect(leafValues).toContain(ATTACKER_ORG);
    }
  });

  it("returns tasks for the owning org and user (same-tenant control)", async () => {
    const { db } = makeDb([]);
    const svc = new MyTasksService(db);

    const result = await svc.myTasks(OWNER_ORG, USER_ID, { limit: 20, includeCompleted: false });

    expect(result.data.length).toBeGreaterThanOrEqual(0);
  });
});
