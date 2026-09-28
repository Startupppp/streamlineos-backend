import type { Db } from "./drizzle.types";
import { routingStrategyFor, type ReplicaRouter, ReplicaShedError } from "./replica-router";
import type { WorkClass } from "../common/admission/work-class";
import { getTenantContext } from "../common/tenant/tenant-context";

export { ReplicaShedError };

export async function routedRead<T>(
  wc: WorkClass,
  primary: Db,
  replica: Db,
  router: ReplicaRouter,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (routingStrategyFor(wc) === "primary-required") {
    return fn(primary);
  }

  if (getTenantContext() !== undefined) {
    return fn(primary);
  }

  const handle = await router.route(wc);
  return fn(handle.id === "replica" ? replica : primary);
}
