import { sql } from "drizzle-orm";
import { accessVersions } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import {
  accessVersionChannel,
  type InProcessListener,
} from "./access-version-channel";
import { registerAfterCommit } from "../tenant/tenant-context";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function subscribeVersionBump(fn: InProcessListener): () => void {
  return accessVersionChannel.subscribe(fn);
}

const ABSENT_ROW_VERSION = 1;
const FIRST_BUMPED_VERSION = ABSENT_ROW_VERSION + 1;

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
  const publish = async (): Promise<void> => accessVersionChannel.publish(orgId);
  if (!registerAfterCommit(publish)) await publish();
}
