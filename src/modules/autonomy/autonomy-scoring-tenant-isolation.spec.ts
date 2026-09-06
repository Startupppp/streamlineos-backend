/**
 * AutonomyScoringService — cross-tenant isolation
 *
 * Proves settingsFor scopes its query to the caller's org.
 * A settings row owned by OWNER_ORG must be invisible to ATTACKER_ORG
 * (ATTACKER_ORG gets defaults, OWNER_ORG gets its stored value).
 */

import type { Db } from "../../db/drizzle.types";
import { AutonomySettingsService } from "./autonomy-settings.service";

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
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const SETTINGS_ROW = {
  organizationId: OWNER_ORG,
  shadowSampleRate: "0.500",
  shadowDailyCap: 50,
  holdWindowSeconds: 600,
};

function makeDb(rows: unknown[]) {
  const where = jest.fn();
  const limit = jest.fn().mockResolvedValue(rows);
  where.mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) }) }),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
  } as unknown as Db;
  return { db, where };
}

describe("AutonomySettingsService — cross-tenant isolation", () => {
  it("returns defaults for a different org (cross-tenant isolation — no data leakage)", async () => {
    const { db, where } = makeDb([]);
    const svc = new AutonomySettingsService(db);

    const result = await svc.settingsFor(ATTACKER_ORG);

    expect(result.shadowDailyCap).toBeDefined();
    expect(where).toHaveBeenCalled();
    const callArg = where.mock.calls[0]?.[0];
    expect(sqlValues(callArg)).toContain(ATTACKER_ORG);
  });

  it("returns stored settings for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([SETTINGS_ROW]);
    const svc = new AutonomySettingsService(db);

    const result = await svc.settingsFor(OWNER_ORG);

    expect(result.holdWindowSeconds).toBe(600);
    expect(result.shadowDailyCap).toBe(50);
  });
});
