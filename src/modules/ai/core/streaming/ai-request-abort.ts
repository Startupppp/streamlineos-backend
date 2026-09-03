import { AsyncLocalStorage } from "node:async_hooks";
import { getTenantAbortSignal } from "../../../../common/tenant/tenant-context";

const storage = new AsyncLocalStorage<AbortSignal>();

export function runWithAiRequestAbort<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(signal, fn);
}

/**
 * Every AI controller is `@NoTenantTransaction()`, so the abort signal the
 * tenant interceptor builds is never established on these routes and the gateway
 * would have nothing to cancel with. This is the request-scoped signal the AI
 * surfaces run under; background work (jobs, cron, outbox) has none, which is
 * why the gateway treats an absent signal as "nothing to cancel" rather than
 * synthesising one.
 */
export function getAiRequestAbortSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/**
 * The cancellation signal armed for the current request, whichever interceptor
 * armed it. `AiRequestAbortInterceptor` is the only source on the
 * `@NoTenantTransaction()` AI routes, but 19 metered controllers reach the
 * gateway without ever opting into it — and on those a client that hung up
 * handed the provider no signal at all, so the org paid for a completion nobody
 * would read. Every authenticated route already carries a disconnect signal on
 * the tenant context; reading it here is what closes them. Background work
 * (jobs, cron, outbox) still has neither, so an absent signal stays "nothing to
 * cancel" rather than a synthesised one.
 */
export function getAmbientAiAbortSignal(): AbortSignal | undefined {
  return storage.getStore() ?? getTenantAbortSignal();
}
