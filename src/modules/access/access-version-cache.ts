import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { accessVersions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { VersionEntry } from "./access.types";

export const VERSION_CACHE_TTL_MS = 1_000;

@Injectable()
export class AccessVersionCache {
  private readonly versionCache = new Map<string, VersionEntry>();
  private readonly versionInFlight = new Map<string, Promise<number>>();

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  clearForOrg(orgId: string): void {
    this.versionCache.delete(orgId);
    this.versionInFlight.delete(orgId);
  }

  private async loadDurable(orgId: string): Promise<number> {
    const row = await runInTenantTransaction(
      this.db,
      () =>
        this.db.query.accessVersions.findFirst({
          where: eq(accessVersions.orgId, orgId),
          columns: { permissionsVersion: true },
        }),
      { orgId },
    );
    return row?.permissionsVersion ?? 1;
  }

  async getVersion(orgId: string): Promise<number> {
    const cached = this.versionCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.version;

    const existing = this.versionInFlight.get(orgId);
    if (existing) return existing;

    const load = this.loadDurable(orgId)
      .then((version) => {
        this.versionCache.set(orgId, {
          version,
          expiresAt: Date.now() + VERSION_CACHE_TTL_MS,
        });
        if (this.versionCache.size > 2000) {
          const now = Date.now();
          for (const [key, entry] of this.versionCache) {
            if (entry.expiresAt <= now) this.versionCache.delete(key);
          }
        }
        return version;
      })
      .finally(() => {
        this.versionInFlight.delete(orgId);
      });

    this.versionInFlight.set(orgId, load);
    return load;
  }
}
