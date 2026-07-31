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

@Injectable()
export class TenantContextService {
  run<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    return storage.run(context, fn);
  }

  current(): TenantContext | undefined {
    return storage.getStore();
  }
}
