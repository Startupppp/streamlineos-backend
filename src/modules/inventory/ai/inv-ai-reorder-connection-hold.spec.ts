import { GUARDS_METADATA, INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { ServiceUnavailableException } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { getTenantContext } from "../../../common/tenant/tenant-context";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../../db/drizzle.module";
import { PermissionGuard } from "../../access/permission.guard";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming";
import { ForecastPersistenceService } from "../replenishment/forecast/forecast-persistence.service";
import { PoBatchService } from "../replenishment/forecast/po-batch.service";
import { InvAiExplainController } from "./inv-ai-explain.controller";
import { InvAiProposalService } from "./proposals/inv-ai-proposal.service";

const USER = {
  orgId: "org-1",
  userId: "user-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
} as const;

const FORECAST_ROW = {
  id: 501,
  orgId: USER.orgId,
  productVariantId: 77,
  warehouseId: 5,
  generatedAt: new Date("2026-08-01T00:00:00.000Z"),
  historyWeeks: 52,
  horizonWeeks: 4,
  periods: 52,
  coverageFrom: "2025-08-01",
  coverageTo: "2026-08-01",
  method: "holt",
  demandCategory: "smooth",
  seasonLength: null,
  mae: "1.0000",
  rmse: "1.2000",
  bias: "0.1000",
  mase: "0.8000",
  serviceLevel: "0.9500",
  applicable: true,
  refusalReason: null,
  safetyStock: "18.0000",
  reorderPoint: "120.0000",
  leadTimeDemand: "60.0000",
  z: "1.6449",
  demandMean: "30.0000",
  demandStdDev: "4.0000",
  leadTimeWeeks: "2.0000",
  leadTimeStdDevWeeks: "0.5000",
  leadTimeObservations: 12,
  censoredPeriods: 0,
  stockoutCensored: false,
  assumptions: {},
  inputFingerprint: "fingerprint",
};

const RESOLVED_ROW = {
  proposal_id: 501,
  product_variant_id: 77,
  warehouse_id: 5,
  warehouse_name: "Main WH",
  reorder_point: "120.0000",
  applicable: true,
  refusal_reason: null,
  generated_at: new Date("2026-08-01T00:00:00.000Z"),
  variant_sku: "SKU-077",
  product_name: "Widget",
  min_order_qty: "1.0000",
  order_multiple: "1.0000",
  vendor_id: 9,
  vendor_name: "Acme",
  currency: "INR",
  available: "84.0000",
  on_order: "0.0000",
  last_unit_cost: "12.5000",
  duplicate_po_id: null,
  duplicate_po_number: null,
};

const NARRATION = {
  status: "ok" as const,
  explanation: "The live position is below the stored reorder point.",
  factors: [{ label: "Order quantity", value: "36.0000", isFactual: true }],
  recommendations: [
    {
      action: "draft_purchase_order" as const,
      rationale: "The persisted forecast and live position support a draft order.",
      evidence: [{ kind: "product_variant" as const, id: 77 }],
    },
  ],
};

const AI_USAGE = {
  model: "test-model",
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  credits: 1,
  costUsd: 0.0001,
};

interface Trace {
  transactionDepth: number;
  transactions: number;
  dbDepths: number[];
  tenantOrgIds: Array<string | undefined>;
  providerDepth: number | undefined;
  writeDepth: number | undefined;
}

function record<T>(trace: Trace, value: T): Promise<T> {
  trace.dbDepths.push(trace.transactionDepth);
  trace.tenantOrgIds.push(getTenantContext()?.orgId);
  return Promise.resolve(value);
}

function tracingDb(trace: Trace, forecastRows: readonly object[]): Db {
  let executeCalls = 0;
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => record(trace, forecastRows),
  };
  const db = {
    select: () => chain,
    execute: () => {
      executeCalls += 1;
      return record(trace, executeCalls >= 3 ? [RESOLVED_ROW] : []);
    },
    transaction: async <T>(run: (tx: Db) => Promise<T>): Promise<T> => {
      trace.transactions += 1;
      trace.transactionDepth += 1;
      try {
        return await run(db as unknown as Db);
      } finally {
        trace.transactionDepth -= 1;
      }
    },
  };
  return db as unknown as Db;
}

function newTrace(): Trace {
  return {
    transactionDepth: 0,
    transactions: 0,
    dbDepths: [],
    tenantOrgIds: [],
    providerDepth: undefined,
    writeDepth: undefined,
  };
}

function makeService(
  trace: Trace,
  providerResult:
    | { ok: true; data: typeof NARRATION; aiUsage: typeof AI_USAGE; correlationId: string }
    | { ok: false; kind: "provider_unavailable"; message: string; correlationId: string },
  forecastRows: readonly object[] = [FORECAST_ROW],
) {
  const db = tracingDb(trace, forecastRows);
  const forecasts = new ForecastPersistenceService(db, {} as never, {} as never);
  const warehouseScope = {
    assertWarehouseVisible: jest.fn(async (orgId: string) => {
      trace.dbDepths.push(trace.transactionDepth);
      trace.tenantOrgIds.push(getTenantContext()?.orgId);
      expect(orgId).toBe(USER.orgId);
    }),
  };
  const batches = new PoBatchService(
    db,
    {} as never,
    {} as never,
    warehouseScope as never,
    {} as never,
  );
  const gateway = {
    invokeStructuredWithUsage: jest.fn(async () => {
      trace.providerDepth = getTenantContext() ? trace.transactionDepth : 0;
      return providerResult;
    }),
  };
  const confirmation = {
    propose: jest.fn(() =>
      runInTenantTransaction(
        db,
        async () => {
          trace.writeDepth = trace.transactionDepth;
          return {
            proposalId: 900,
            token: "token",
            expiresAt: new Date("2026-08-01T00:02:00.000Z"),
          };
        },
        { orgId: USER.orgId },
      ),
    ),
  };
  return {
    service: new InvAiProposalService(
      gateway as never,
      confirmation as never,
      {} as never,
      batches,
      forecasts,
    ),
    gateway,
    confirmation,
  };
}

describe("inventory reorder proposal connection hold", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it("keeps unauthenticated and unauthorized requests outside the proposal service", () => {
    const controllerGuards =
      (Reflect.getMetadata(GUARDS_METADATA, InvAiExplainController) as unknown[]) ?? [];
    const handlerGuards =
      (Reflect.getMetadata(
        GUARDS_METADATA,
        InvAiExplainController.prototype.getReorderProposal,
      ) as unknown[]) ?? [];

    expect(controllerGuards).toContain(JwtAuthGuard);
    expect(handlerGuards).toContain(PermissionGuard);
  });

  it("opts only the provider-backed proposal handler out of the request transaction", () => {
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        InvAiExplainController.prototype.getReorderProposal,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        InvAiExplainController.prototype.confirmReorderProposal,
      ),
    ).toBeUndefined();
  });

  it("retains the abort interceptor while the request transaction is disabled", () => {
    const interceptors =
      (Reflect.getMetadata(INTERCEPTORS_METADATA, InvAiExplainController) as unknown[]) ?? [];
    expect(interceptors).toContain(AiRequestAbortInterceptor);
  });

  it("releases both read transactions before provider failure and opens no write transaction", async () => {
    const trace = newTrace();
    const { service, confirmation } = makeService(trace, {
      ok: false,
      kind: "provider_unavailable",
      message: "provider unavailable",
      correlationId: "corr-fail",
    });

    await expect(service.propose(USER, { variantId: 77, warehouseId: 5 })).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(trace.providerDepth).toBe(0);
    expect(trace.transactions).toBe(2);
    expect(trace.transactionDepth).toBe(0);
    expect(trace.writeDepth).toBeUndefined();
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("fails closed on an empty scoped read without invoking the provider", async () => {
    const trace = newTrace();
    const { service, gateway, confirmation } = makeService(
      trace,
      {
        ok: false,
        kind: "provider_unavailable",
        message: "must not be reached",
        correlationId: "corr-empty",
      },
      [],
    );

    await expect(service.propose(USER, { variantId: 77, warehouseId: 5 })).rejects.toThrow(
      "No stored forecast exists",
    );

    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
    expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(confirmation.propose).not.toHaveBeenCalled();
  });

  it("keeps reads and the persistence write in short tenant transactions with AI at depth zero", async () => {
    const trace = newTrace();
    const { service } = makeService(trace, {
      ok: true,
      data: NARRATION,
      aiUsage: AI_USAGE,
      correlationId: "corr-ok",
    });

    await service.propose(USER, { variantId: 77, warehouseId: 5 });

    const scopedOrgIds = trace.tenantOrgIds.filter((orgId) => orgId !== undefined);
    expect(trace.dbDepths.length).toBeGreaterThan(0);
    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(scopedOrgIds.length).toBeGreaterThan(0);
    expect(scopedOrgIds.every((orgId) => orgId === USER.orgId)).toBe(true);
    expect(trace.providerDepth).toBe(0);
    expect(trace.writeDepth).toBe(1);
    expect(trace.transactions).toBe(3);
    expect(trace.transactionDepth).toBe(0);
  });
});
