jest.mock("../../integrations/core/composio.gateway", () => ({
  ComposioGateway: class {},
  ComposioToolError: class extends Error {},
}));
jest.mock("../inbound-ingress.service", () => ({ InboundIngressService: class {} }));

import type { Db } from "../../../db/drizzle.types";
import { TelephonyCallLogService } from "./telephony-call-log.service";
import { NotFoundException } from "@nestjs/common";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("TelephonyCallLogService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const CONN_ID = 99;

  function makeDb(wheres: unknown[], rows: unknown[] = []) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Object.assign(Promise.resolve(rows), {
              limit: jest.fn().mockResolvedValue(rows),
            });
          }),
        }),
      })),
    } as unknown as Db;
  }

  it("scopes connection lookup to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new TelephonyCallLogService(makeDb(wheres, []), {} as never, {} as never);

    await svc.sync(ATTACKER, CONN_ID);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns a refusal when connection not found for org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new TelephonyCallLogService(makeDb(wheres, []), {} as never, {} as never);

    const result = await svc.sync(OWNER, CONN_ID);

    expect(result).toBeDefined();
    expect(result.swept).toBe(false);
  });
});
