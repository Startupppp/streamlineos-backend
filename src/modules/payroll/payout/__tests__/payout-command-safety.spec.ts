process.env.APP_URL ??= "http://localhost:1000";

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The route that mints payment instructions is fenced on the server.
 *
 * `POST /payroll/runs/:runId/payout/batches` read `idempotency-key` as an
 * optional header and required nothing, so replay protection was whatever the
 * caller volunteered. `check:idempotent-commands` never caught it: that gate
 * tests `CRITICAL_ROUTE_RE` against the string on the decorator — `"batches"` —
 * not against the controller prefix `payroll/runs/:runId/payout` that makes it
 * a payout, and `createBatch` is not in its `CRITICAL_METHOD_RE` either. So the
 * hole was invisible to the very gate whose job it was.
 *
 * This spec is the module-local backstop for that blind spot. It pins both
 * halves of the contract: the decorator on the handler (the interceptor rejects
 * a missing key with 400 and fences a concurrent duplicate with 409), and the
 * published document that tells clients the header exists.
 */
const controllerSource = readFileSync(
  join(__dirname, "..", "payout-batches.controller.ts"),
  "utf8",
);

interface OpenApiOperation {
  operationId?: string;
  parameters?: Array<{ $ref?: string }>;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
}

const openapi: OpenApiDocument = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "..", "openapi.json"), "utf8"),
);

describe("payroll payout command safety", () => {
  it("fences payout batch creation and still forwards the key as the per-currency sub-key", () => {
    const decoratorStart = controllerSource.indexOf(
      '@Idempotent("payroll.payout.batch.create")',
    );
    expect(decoratorStart).toBeGreaterThan(-1);

    const handlerStart = controllerSource.indexOf("createBatch(", decoratorStart);
    expect(handlerStart).toBeGreaterThan(decoratorStart);

    const handlerSource = controllerSource.slice(decoratorStart, handlerStart + 500);
    expect(handlerSource).toContain('@Headers("idempotency-key") idempotencyKey');
    expect(handlerSource).toMatch(
      /this\.batchCreator\.createBatch\([\s\S]*idempotencyKey/,
    );
  });

  it("declares the Idempotency-Key header on the published operation", () => {
    const operation = openapi.paths?.["/payroll/runs/{runId}/payout/batches"]?.post;
    expect(operation?.operationId).toBe("PayoutRunController_createBatch");
    expect(operation?.parameters ?? []).toContainEqual({
      $ref: "#/components/parameters/IdempotencyKeyHeader",
    });
  });

  it("keeps the bank-return import fenced too", () => {
    expect(controllerSource).toContain('@Idempotent("payroll.bank-return.import")');
  });
});
