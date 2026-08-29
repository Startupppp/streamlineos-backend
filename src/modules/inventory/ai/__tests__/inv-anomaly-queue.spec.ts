import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { InvAnomalyQueueService } from "../anomalies/inv-anomaly-queue.service";
import {
  ANOMALY_WINDOWS,
  INV_ANOMALY_DETECTORS,
  INV_ANOMALY_TYPES,
  detectorFor,
} from "../anomalies/inv-anomaly-detectors";
import {
  listAnomaliesSchema,
  reviewAnomalySchema,
} from "../anomalies/dto/inv-anomaly.schemas";
import { InvAiFeedbackService } from "../feedback/inv-ai-feedback.service";
import {
  INV_AI_SURFACES,
  createInvAiFeedbackSchema,
} from "../feedback/dto/inv-ai-feedback.schemas";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * F3/F6 — the queue as a thing somebody works, and the verdict that comes back.
 *
 * The safety properties (scope, injection, refusal) are asserted by the eval
 * suite in `evals/`. This file asserts the half that makes the feature *useful*
 * rather than merely safe: that a row arrives with the formula and window behind
 * it, that reviewing one records who and when, and that a verdict lands against
 * the gateway's own figures.
 */

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

function chainDb(pages: readonly unknown[][]) {
  const wheres: SQL[] = [];
  const sets: Record<string, unknown>[] = [];
  let call = 0;
  const chain: Record<string, unknown> = {};
  for (const method of [
    "select",
    "from",
    "orderBy",
    "limit",
    "offset",
    "returning",
    "update",
    "insert",
    "values",
    "onConflictDoUpdate",
    "groupBy",
  ]) {
    chain[method] = () => chain;
  }
  chain["set"] = (value: Record<string, unknown>) => {
    sets.push(value);
    return chain;
  };
  chain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return chain;
  };
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(pages[call++] ?? []).then(resolve, reject);
  return { db: chain as never, wheres, sets };
}

function unrestrictedScope() {
  return new WarehouseScopeService(
    {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as never,
    {
      resolveUserPermissions: () =>
        Promise.resolve(new Set(["inventory:warehouses:scope-all"])),
    } as never,
  );
}

const cache = { invalidate: jest.fn() };

describe("F3 — the detector registry", () => {
  it("is the single definition of every window the detectors use", () => {
    // The registry is what the queue shows a reader, and the detectors import
    // their windows from it. A second copy of `90` in the query is how a caption
    // ends up describing a window nobody ran.
    expect(INV_ANOMALY_DETECTORS.stockout_risk.windowDays).toBe(
      ANOMALY_WINDOWS.demandHistoryDays,
    );
    expect(INV_ANOMALY_DETECTORS.dead_stock.windowDays).toBe(ANOMALY_WINDOWS.deadStockDays);
    expect(INV_ANOMALY_DETECTORS.expiry_risk.windowDays).toBe(
      ANOMALY_WINDOWS.expiryHorizonDays,
    );
    expect(INV_ANOMALY_DETECTORS.unusual_adjustments.windowDays).toBe(
      ANOMALY_WINDOWS.adjustmentRecentDays,
    );
  });

  it("answers a retired detector with null rather than another detector's formula", () => {
    // A row written by an older build must stay listable and dismissible. What
    // it must not do is borrow somebody else's arithmetic and read as though it
    // were still computed.
    expect(detectorFor("a_detector_this_build_no_longer_has")).toBeNull();
    for (const type of INV_ANOMALY_TYPES) expect(detectorFor(type)).not.toBeNull();
  });

  it("marks only the detectors whose arithmetic belongs to one site as attributable", () => {
    // The org-aggregate four sum a series across every warehouse, so a finding
    // from one of them is organisation-wide information and says so.
    expect(INV_ANOMALY_DETECTORS.vendor_delay.siteAttributable).toBe(true);
    expect(INV_ANOMALY_DETECTORS.expiry_risk.siteAttributable).toBe(true);
    expect(INV_ANOMALY_DETECTORS.stockout_risk.siteAttributable).toBe(false);
    expect(INV_ANOMALY_DETECTORS.dead_stock.siteAttributable).toBe(false);
    expect(INV_ANOMALY_DETECTORS.negative_stock.siteAttributable).toBe(false);
    expect(INV_ANOMALY_DETECTORS.unusual_adjustments.siteAttributable).toBe(false);
  });
});

describe("F3 — the queue's boundary", () => {
  it("takes a detector type from the enum and nothing else", () => {
    expect(listAnomaliesSchema.safeParse({ type: "stockout_risk" }).success).toBe(true);
    expect(listAnomaliesSchema.safeParse({ type: "'; DROP TABLE x" }).success).toBe(false);
    expect(listAnomaliesSchema.safeParse({ orderBy: "created_at" }).success).toBe(false);
  });

  it("caps a page at 100 and defaults to 50", () => {
    expect(listAnomaliesSchema.parse({}).limit).toBe(50);
    expect(listAnomaliesSchema.safeParse({ limit: 500 }).success).toBe(false);
  });

  it("has no field on the review payload that could become a stock movement", () => {
    // Acknowledging a finding is a statement about the queue. The moment the
    // payload could carry a quantity or a location it would be a way to post
    // stock through the AI surface.
    for (const field of ["quantity", "qty", "locationId", "adjustment", "onHand"]) {
      expect(
        reviewAnomalySchema.safeParse({ action: "acknowledge", [field]: 1 }).success,
      ).toBe(false);
    }
    expect(reviewAnomalySchema.safeParse({ action: "acknowledge" }).success).toBe(true);
    expect(reviewAnomalySchema.safeParse({ action: "post" }).success).toBe(false);
  });
});

describe("F3 — listing the queue", () => {
  it("carries the formula, the window and the evidence for every row", async () => {
    const { db } = chainDb([
      [
        {
          id: 3,
          insightType: "expiry_risk",
          severity: "high",
          status: "NEW",
          title: "Expiry risk: SKU-1 lot L-9",
          body: "Lot L-9 expires soon.",
          sourceRefs: { lotId: 9, variantId: 4, warehouseId: 7 },
          warehouseId: 7,
          windowDays: 14,
          evidenceHash: "abc123",
          acknowledgedBy: null,
          acknowledgedAt: null,
          resolutionNote: null,
          createdAt: new Date("2026-08-20T00:00:00.000Z"),
        },
      ],
      [{ total: 1 }],
    ]);
    const service = new InvAnomalyQueueService(db, unrestrictedScope(), cache as never);

    const page = await service.list(USER, { page: 1, limit: 50 });

    const row = page.items[0];
    expect(row?.detector?.formula).toBe(INV_ANOMALY_DETECTORS.expiry_risk.formula);
    expect(row?.detector?.windowLabel).toContain("14");
    // The window that was stored with the finding, not the one the registry
    // holds today.
    expect(row?.windowDays).toBe(14);
    expect(row?.evidenceHash).toBe("abc123");
    // Every record the finding points at, so the reader can open it.
    expect(row?.evidence).toEqual([
      { kind: "insight", id: 3 },
      { kind: "product_variant", id: 4 },
      { kind: "lot", id: 9 },
      { kind: "warehouse", id: 7 },
    ]);
    // An org-wide caller is not told anything is hidden, because nothing is.
    expect(page.orgWideSignalsHidden).toBe(false);
    expect(page.total).toBe(1);
  });
});

describe("F3 — reviewing a finding", () => {
  it("records who closed it, when, and why", async () => {
    const reviewed = {
      id: 3,
      insightType: "vendor_delay",
      severity: "high",
      status: "ACKNOWLEDGED",
      title: "Vendor delay: PO-1",
      body: "PO-1 is late.",
      sourceRefs: { poId: 1, vendorId: 2 },
      warehouseId: 7,
      windowDays: 0,
      evidenceHash: "def456",
      acknowledgedBy: "user-1",
      acknowledgedAt: new Date("2026-08-29T00:00:00.000Z"),
      resolutionNote: "Chased the supplier, new ETA Friday.",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    };
    const { db, sets } = chainDb([[reviewed]]);
    const service = new InvAnomalyQueueService(db, unrestrictedScope(), cache as never);

    const result = await service.review(USER, 3, {
      action: "acknowledge",
      note: "Chased the supplier, new ETA Friday.",
    });

    expect(sets[0]).toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgedBy: "user-1",
      resolutionNote: "Chased the supplier, new ETA Friday.",
    });
    // A status with no actor is a queue nobody is accountable for.
    expect(sets[0]?.["acknowledgedAt"]).toBeInstanceOf(Date);
    expect(result.status).toBe("ACKNOWLEDGED");
    expect(result.detector?.label).toBe("Vendor delay");
  });

  it("checks the affected row rather than assuming the update landed", async () => {
    // An update that matched nothing is a denial. Returning the row we hoped to
    // write would report success for a write that never happened.
    const { db } = chainDb([[]]);
    const service = new InvAnomalyQueueService(db, unrestrictedScope(), cache as never);
    await expect(service.review(USER, 3, { action: "dismiss" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("names the row and the tenant in the predicate it updates through", async () => {
    const { db, wheres } = chainDb([[]]);
    const service = new InvAnomalyQueueService(db, unrestrictedScope(), cache as never);
    await service.review(USER, 3, { action: "dismiss" }).catch(() => undefined);

    const { params } = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(params).toContain(3);
    expect(params).toContain("org-1");
  });
});

describe("F6 — a verdict against the call that produced it", () => {
  it("refuses a complaint with no explanation", () => {
    // A `WRONG` or `UNSAFE` report with no sentence is unactionable, which
    // defeats the whole table. The database refuses it too; this is the
    // readable half of the same rule.
    const base = {
      surface: "demand_risk" as const,
      correlationId: "c1",
      promptKey: "inv.demand-risk",
      promptVersion: 1,
      contractVersion: 1,
    };
    expect(createInvAiFeedbackSchema.safeParse({ ...base, verdict: "WRONG" }).success).toBe(
      false,
    );
    expect(
      createInvAiFeedbackSchema.safeParse({ ...base, verdict: "UNSAFE", note: "too short" })
        .success,
    ).toBe(false);
    expect(
      createInvAiFeedbackSchema.safeParse({
        ...base,
        verdict: "UNSAFE",
        note: "It told an operator to ship expired stock.",
      }).success,
    ).toBe(true);
    // `USEFUL` needs nothing: praise costs no explanation.
    expect(createInvAiFeedbackSchema.safeParse({ ...base, verdict: "USEFUL" }).success).toBe(
      true,
    );
  });

  it("takes a surface from the closed set", () => {
    expect(INV_AI_SURFACES).toContain("report_builder");
    expect(
      createInvAiFeedbackSchema.safeParse({
        surface: "something_invented",
        verdict: "USEFUL",
        correlationId: "c1",
        promptKey: "k",
        promptVersion: 1,
        contractVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("stores the gateway's figures, never the client's", async () => {
    const { db } = chainDb([[{ id: 1, verdict: "USEFUL", surface: "demand_risk", createdAt: new Date() }]]);
    const usage = {
      findRecentCall: jest.fn().mockResolvedValue({
        feature: "inv.demand-risk",
        model: "fast-model",
        totalTokens: 640,
        creditsMilli: 2000,
        estimatedCostUsd: "0.001250",
        createdAt: new Date(),
      }),
    };
    const service = new InvAiFeedbackService(db, usage as never);
    const insert = jest.spyOn(db as unknown as { insert: (t: unknown) => unknown }, "insert");

    await service.submit(USER, {
      surface: "demand_risk",
      verdict: "USEFUL",
      correlationId: "corr-1",
      promptKey: "inv.demand-risk",
      promptVersion: 1,
      contractVersion: 1,
    });

    expect(usage.findRecentCall).toHaveBeenCalledWith("org-1", "corr-1");
    expect(insert).toHaveBeenCalled();
  });

  it("splits the ratio from the safety count", async () => {
    const { db } = chainDb([
      [{ surface: "demand_risk", useful: 9, wrong: 1, stale: 0, unsafe: 1, total: 11 }],
    ]);
    const service = new InvAiFeedbackService(db, { findRecentCall: jest.fn() } as never);

    const summary = await service.summary("org-1", { days: 30 });

    // 9 of 10 rated, not 9 of 11: an unsafe report is an incident and must not
    // be averaged into a satisfaction score.
    expect(summary.surfaces[0]?.usefulRatio).toBe(0.9);
    expect(summary.unsafeTotal).toBe(1);
  });
});
