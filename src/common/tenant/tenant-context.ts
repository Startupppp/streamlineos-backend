import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import type { TenantTx } from "./with-tenant";

export type TenantAudience = "INTERNAL" | "PORTAL";

export interface TenantContext {
  orgId: string;
  audience: TenantAudience;
  /** The in-flight transaction carrying this request's tenant GUC. */
  tx: TenantTx;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * Establishes the ambient context so the DRIZZLE proxy routes to `context.tx`.
 *
 * Opening a tenant transaction is not enough on its own: services injected
 * elsewhere hold the proxied `db`, not the `tx`, and only find it through this
 * storage. A sweep that opened a transaction without this would still issue its
 * nested service calls on the pool, with no tenant GUC.
 */
export function runWithTenantContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function runOutsideTenantContext<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}

@Injectable()
export class TenantContextService {
  run<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    return storage.run(context, fn);
  }

  current(): TenantContext | undefined {
    return storage.getStore();
  }
}
