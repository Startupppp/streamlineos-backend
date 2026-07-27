import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import type { TenantContext } from "../../db/rls-context";

const als = new AsyncLocalStorage<TenantContext>();

export function getAmbientTenantContext(): TenantContext | undefined {
  return als.getStore();
}

@Injectable()
export class TenantContextService {
  run<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return als.run(ctx, fn);
  }

  current(): TenantContext | undefined {
    return als.getStore();
  }
}
