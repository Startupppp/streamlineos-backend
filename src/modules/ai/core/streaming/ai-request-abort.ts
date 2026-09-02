import { AsyncLocalStorage } from "node:async_hooks";

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
