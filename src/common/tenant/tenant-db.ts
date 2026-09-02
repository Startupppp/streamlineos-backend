import type { Db } from "../../db/drizzle.types";
import { getTenantContext } from "./tenant-context";

export type DbWithClient = Db & { __client: { end: (opts: { timeout: number }) => Promise<void> } };

/**
 * Routes every query to the request's tenant transaction when one is in flight.
 *
 * 557 of 767 service files never open a transaction, so they issue autocommit
 * statements that cannot carry a `SET LOCAL` tenant GUC. Rather than rewrite
 * them, this proxy makes `this.db.select()` resolve to the ambient `tx` whose
 * GUC is already set, and fall through to the pool when there is no context.
 */
export function createTenantAwareDb(db: DbWithClient): DbWithClient {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "__client") return target.__client;

      const context = getTenantContext();
      const source: object = context ? (context.tx as object) : target;
      const value: unknown = Reflect.get(source, prop, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  }) as DbWithClient;
}
