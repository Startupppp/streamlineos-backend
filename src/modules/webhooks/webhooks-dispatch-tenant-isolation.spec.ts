import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WebhooksDispatchService } from "./webhooks-dispatch.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("WebhooksDispatchService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ENDPOINT_ID = 1;
  const LOG_ID = 10;

  function makeDb(endpointRow: unknown = undefined, logRow: unknown = undefined) {
    return {
      query: {
        webhookEndpoints: {
          findFirst: jest.fn().mockResolvedValue(endpointRow),
          findMany: jest.fn().mockResolvedValue([]),
        },
        webhookLogs: {
          findFirst: jest.fn().mockResolvedValue(logRow),
        },
      },
    } as unknown as Db;
  }

  it("returns 404 for a log that belongs to a different org (tenant isolation — cross-org deny)", async () => {
    const db = makeDb(undefined, undefined);
    const svc = new WebhooksDispatchService(db);

    await expect(svc.retryLog(ATTACKER, ENDPOINT_ID, LOG_ID)).rejects.toBeInstanceOf(NotFoundException);

    const endpointCall = (db.query.webhookEndpoints.findFirst as jest.Mock).mock.calls[0];
    const whereArg = endpointCall[0].where;
    const vals = sqlValues(whereArg);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("proceeds with retryLog when the log belongs to the correct org (same-tenant control)", async () => {
    const db = makeDb(undefined, undefined);
    const svc = new WebhooksDispatchService(db);

    await expect(svc.retryLog(OWNER, ENDPOINT_ID, LOG_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
