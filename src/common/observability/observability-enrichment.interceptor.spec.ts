import { of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { ObservabilityEnrichmentInterceptor } from "./observability-enrichment.interceptor";
import { getObservabilityContext, runWithObservabilityContext } from "./observability-context";

function httpContext(req: unknown): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of(null) };

describe("ObservabilityEnrichmentInterceptor", () => {
  it("stamps the organisation and actor once authentication has resolved them", async () => {
    const interceptor = new ObservabilityEnrichmentInterceptor();

    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      interceptor.intercept(
        httpContext({ user: { orgId: "org-1", userId: "user-1" } }),
        next,
      );
      expect(getObservabilityContext()).toMatchObject({ orgId: "org-1", actorId: "user-1" });
    });
  });

  it("stamps the organisation for a portal caller", async () => {
    const interceptor = new ObservabilityEnrichmentInterceptor();

    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      interceptor.intercept(
        httpContext({ portalUser: { organizationId: "org-2", portalUserId: "p-1" } }),
        next,
      );
      expect(getObservabilityContext()).toMatchObject({ orgId: "org-2", actorId: "p-1" });
    });
  });

  it("leaves an anonymous request unstamped rather than inventing an actor", async () => {
    const interceptor = new ObservabilityEnrichmentInterceptor();

    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      interceptor.intercept(httpContext({}), next);
      expect(getObservabilityContext()).toEqual({ correlationId: "c-1" });
    });
  });

  it("ignores a signed-in user with no workspace yet", async () => {
    const interceptor = new ObservabilityEnrichmentInterceptor();

    await runWithObservabilityContext({ correlationId: "c-1" }, async () => {
      interceptor.intercept(httpContext({ user: { orgId: "", userId: "user-1" } }), next);
      expect(getObservabilityContext()).toEqual({ correlationId: "c-1", actorId: "user-1" });
    });
  });

  it("passes non-http contexts straight through", () => {
    const interceptor = new ObservabilityEnrichmentInterceptor();
    const ctx = { getType: () => "rpc" } as unknown as ExecutionContext;
    expect(() => interceptor.intercept(ctx, next)).not.toThrow();
  });
});
