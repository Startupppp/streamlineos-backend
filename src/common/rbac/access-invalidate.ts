import { sql } from "drizzle-orm";
import { accessVersions } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import {
  accessVersionChannel,
  type AccessVersionListener,
} from "./access-version-channel";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function subscribeVersionBump(fn: AccessVersionListener): () => void {
  return accessVersionChannel.subscribe(fn);
}

const ABSENT_ROW_VERSION = 1;
const FIRST_BUMPED_VERSION = ABSENT_ROW_VERSION + 1;

/**
 * Published before the caller's transaction commits, deliberately. A rolled-back
 * grant change then costs one wasted re-read; publishing after commit would risk
 * missing one, and a missed invalidation honours a revoked grant.
 */
export async function bumpPermissionsVersion(tx: DbOrTx, orgId: string): Promise<void> {
  await tx
    .insert(accessVersions)
    .values({ orgId, permissionsVersion: FIRST_BUMPED_VERSION })
    .onConflictDoUpdate({
      target: accessVersions.orgId,
      set: {
        permissionsVersion: sql`${accessVersions.permissionsVersion} + 1`,
        updatedAt: new Date(),
      },
    });
  await accessVersionChannel.publish(orgId);
}
