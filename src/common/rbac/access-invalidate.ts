import { sql } from "drizzle-orm";
import { accessVersions } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

type VersionBumpListener = (orgId: string) => void;

const versionBumpListeners = new Set<VersionBumpListener>();

export function subscribeVersionBump(fn: VersionBumpListener): () => void {
  versionBumpListeners.add(fn);
  return () => {
    versionBumpListeners.delete(fn);
  };
}

function notifyVersionBump(orgId: string): void {
  for (const fn of versionBumpListeners) fn(orgId);
}

export async function bumpPermissionsVersion(tx: DbOrTx, orgId: string): Promise<void> {
  await tx
    .insert(accessVersions)
    .values({ orgId })
    .onConflictDoUpdate({
      target: accessVersions.orgId,
      set: {
        permissionsVersion: sql`${accessVersions.permissionsVersion} + 1`,
        updatedAt: new Date(),
      },
    });
  notifyVersionBump(orgId);
}
