import { AsyncLocalStorage } from "node:async_hooks";

export interface ObservabilityContext {
  /** Stable across the whole request, and across services that forward it. */
  readonly correlationId: string;
  /** Known only once authentication has resolved the caller. */
  orgId?: string;
  actorId?: string;
  method?: string;
  route?: string;
  cellId?: string;
  /** Build identifier stamped at the edge from APP_RELEASE so a deploy can be implicated in a spike. */
  release?: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Everything callers may fill in later; the correlation id is fixed at entry. */
export type ObservabilityEnrichment = Omit<
  Partial<ObservabilityContext>,
  "correlationId"
>;

const storage = new AsyncLocalStorage<ObservabilityContext>();

export function getObservabilityContext(): ObservabilityContext | undefined {
  return storage.getStore();
}

export function runWithObservabilityContext<T>(
  context: ObservabilityContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/**
 * Fills in what was not known at the edge. Returns `false` rather than throwing
 * when there is no context — background sweeps legitimately run without one, and
 * a throw here would turn a telemetry gap into an outage.
 *
 * The correlation id is never reassigned: it is the join key, and a caller-supplied
 * value must not be able to displace it mid-request.
 */
export function enrichObservabilityContext(
  patch: ObservabilityEnrichment,
): boolean {
  const context = storage.getStore();
  if (!context) return false;

  // Explicit per field rather than a loop: enrichable keys are a closed set, and
  // an empty string (a signed-in user with no workspace yet) is absence, not a value.
  if (patch.orgId) context.orgId = patch.orgId;
  if (patch.actorId) context.actorId = patch.actorId;
  if (patch.method) context.method = patch.method;
  if (patch.route) context.route = patch.route;
  if (patch.cellId) context.cellId = patch.cellId;
  if (patch.release) context.release = patch.release;
  if (patch.ipAddress) context.ipAddress = patch.ipAddress;
  if (patch.userAgent) context.userAgent = patch.userAgent;
  return true;
}

export function bindObservabilityContext<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const snapshot = storage.getStore();
  if (!snapshot) return fn;

  const frozen: ObservabilityContext = { ...snapshot };
  return (...args: A) => storage.run(frozen, () => fn(...args));
}
