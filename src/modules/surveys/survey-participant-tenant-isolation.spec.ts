import { NotFoundException } from "@nestjs/common";
import { SurveyParticipantService } from "./survey-participant.service";
import type { Db } from "../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}


/**
 * `select({ total }).from(t).where(p)` — the COUNT half of the list envelope.
 *
 * It is a second read of the same table, so it is held to the same tenant predicate as the
 * page read: a count that escaped the org scope would disclose another tenant's row count.
 */
function countSelect(total: number) {
  const countWhere = jest.fn();
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ total }]).then(resolve),
  };
  chain["from"] = jest.fn().mockReturnValue(chain);
  chain["where"] = countWhere.mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain), countWhere };
}

describe("SurveyParticipantService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("refuses a survey owned by a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyForms: { findFirst: jest.fn().mockResolvedValue(undefined) },
        surveyParticipants: { findMany },
      },
    } as unknown as Db;
    const svc = new SurveyParticipantService(db);

    await expect(svc.list(ATTACKER_ORG, 1, { page: 1, pageSize: 20 })).rejects.toThrow(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns participants for the owning org (control — same-tenant)", async () => {
    const participant = { id: 11, orgId: OWNER_ORG, surveyId: 1, email: "alice@example.com", status: "invited" };
    const findMany = jest.fn().mockResolvedValue([participant]);
    const { select, countWhere } = countSelect(1);
    const db = {
      query: {
        surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        surveyParticipants: { findMany },
      },
      select,
    } as unknown as Db;
    const svc = new SurveyParticipantService(db);

    const result = await svc.list(OWNER_ORG, 1, { page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(11);
    expect(result.total).toBe(1);
    expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });
});
