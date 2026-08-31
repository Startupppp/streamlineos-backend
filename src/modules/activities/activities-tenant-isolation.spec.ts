import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { ActivitiesService } from "./activities.service";

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
const audit = { log: jest.fn() };

function makeChainDb(firstCallRows: unknown[], secondCallRows: unknown[] = []): {
  db: Db;
  whereList: jest.Mock[];
} {
  const whereList: jest.Mock[] = [];

  function makeSelectChain(rows: unknown[]) {
    const where = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    });
    whereList.push(where);
    return {
      from: jest.fn().mockReturnValue({ where }),
    };
  }

  let callCount = 0;
  const db = {
    select: jest.fn().mockImplementation(() => {
      callCount += 1;
      return callCount === 1
        ? makeSelectChain(firstCallRows)
        : makeSelectChain(secondCallRows);
    }),
    query: {},
  } as unknown as Db;

  return { db, whereList };
}

describe("ActivitiesService.participants — cross-tenant isolation", () => {
  it("throws NotFoundException when activity belongs to a different org", async () => {
    const { db } = makeChainDb([]);
    const svc = new ActivitiesService(db, audit as never);

    await expect(svc.participants(ATTACKER_ORG, "activity-99")).rejects.toThrow(NotFoundException);
  });

  it("scopes require() query to the requesting org (isolation — where clause contains orgId)", async () => {
    const { db, whereList } = makeChainDb([]);
    const svc = new ActivitiesService(db, audit as never);

    await expect(svc.participants(ATTACKER_ORG, "activity-99")).rejects.toThrow(NotFoundException);

    const firstWhere = whereList[0];
    if (firstWhere?.mock.calls[0]) {
      const leafValues = sqlValues(firstWhere.mock.calls[0][0]);
      expect(leafValues).toContain(ATTACKER_ORG);
    }
  });

  it("returns participants for an activity owned by the correct org (same-tenant control)", async () => {
    const activity = { activityId: "activity-1", organizationId: OWNER_ORG };
    const participant = {
      activityParticipantId: "p-1",
      partyId: null,
      userId: "u-1",
      userName: "Alice",
      address: null,
      role: "attendee",
    };
    const { db } = makeChainDb([activity], [participant]);
    const db2 = {
      ...db,
      select: jest.fn()
        .mockImplementationOnce(() => ({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([activity]) }),
          }),
        }))
        .mockImplementationOnce(() => ({
          from: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([participant]) }),
            }),
          }),
        })),
    } as unknown as Db;

    const svc = new ActivitiesService(db2, audit as never);
    const result = await svc.participants(OWNER_ORG, "activity-1");
    expect(Array.isArray(result)).toBe(true);
  });
});
