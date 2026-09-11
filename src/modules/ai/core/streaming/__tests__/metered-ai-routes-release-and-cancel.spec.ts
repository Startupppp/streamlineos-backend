import { Controller, Post } from "@nestjs/common";
import { NO_TENANT_TRANSACTION } from "../../../../../common/tenant/no-tenant-transaction.decorator";
import { SignAiController } from "../../../../e-sign/sign-ai.controller";
import { TimesheetsAiController } from "../../../../timesheets/core/timesheets-ai.controller";

/**
 * The two halves of the provider-in-transaction fix have to travel together, and
 * only one of them is visible to a gate.
 *
 * `@NoTenantTransaction()` is what releases the pooled connection before the
 * provider round trip, and `check:placement-bypass` can see it — it is the thing
 * that declares itself. What that decorator ALSO does is remove the tenant
 * context's disconnect signal (`TenantContextInterceptor` returns
 * `next.handle()` before it ever calls `createStreamAbortSignal`), and that
 * signal is where `getAmbientAiAbortSignal` found cancellation on these routes.
 * Nothing static can see the absence, so a half-applied fix trades a held
 * connection for an uncancellable provider call the org still pays for
 * (PRD-C091) and every check stays green.
 *
 * These six handlers were shipped with the first half and without the second.
 * This is the pin, the same one `kb-doc-ai-buffered-connection-release.spec.ts`
 * puts on the KB pair.
 */

const INTERCEPTOR_METADATA = "__interceptors__";

function declaresAbortInterceptor(controller: unknown): boolean {
  const interceptors = Reflect.getMetadata(INTERCEPTOR_METADATA, Object(controller)) as
    | unknown[]
    | undefined;
  return (interceptors ?? []).some((i) => {
    const name = typeof i === "function" ? i.name : (i as { constructor?: { name?: string } })?.constructor?.name;
    return name === "AiRequestAbortInterceptor";
  });
}

function optsOutOfTheRequestTransaction(controller: object, handler: string): boolean {
  const target: unknown = Reflect.get((controller as { prototype: object }).prototype, handler);
  if (typeof target !== "function") return false;
  return Reflect.getMetadata(NO_TENANT_TRANSACTION, Object(target)) === true;
}

/**
 * Without this the assertions below would pass on a reflection helper that
 * always answered "yes". It is shaped like these controllers were before the
 * fix: a metered route with neither half applied.
 */
@Controller("unfixed-probe")
class UnfixedProbeController {
  @Post("summarize")
  summarize(): { ok: boolean } {
    return { ok: true };
  }
}

describe.each([
  ["SignAiController", SignAiController, ["summarize"]],
  [
    "TimesheetsAiController",
    TimesheetsAiController,
    ["summarize", "draftRejectionReason", "describeEntry", "billingNarrative", "reportsNarrative"],
  ],
] as const)("%s releases the connection AND keeps the call cancellable", (_name, controller, handlers) => {
  it.each(handlers)("%s carries @NoTenantTransaction()", (handler) => {
    expect(optsOutOfTheRequestTransaction(controller, handler)).toBe(true);
  });

  it("declares AiRequestAbortInterceptor, which is what replaces the tenant context's signal", () => {
    expect(declaresAbortInterceptor(controller)).toBe(true);
  });
});

describe("(anti-vacuous) the same two questions asked of an unfixed controller", () => {
  it("reports no opt-out", () => {
    expect(optsOutOfTheRequestTransaction(UnfixedProbeController, "summarize")).toBe(false);
  });

  it("reports no abort interceptor", () => {
    expect(declaresAbortInterceptor(UnfixedProbeController)).toBe(false);
  });
});
