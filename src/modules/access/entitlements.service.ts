import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { orgModules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "42P01") return true;
  return "message" in error && typeof error.message === "string" && error.message.includes("does not exist");
}

@Injectable()
export class EntitlementsService {
  private missingTableLogged = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private async safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
      if (!this.missingTableLogged) {
        this.missingTableLogged = true;
        logger.warn("entitlements: org_modules table missing, defaulting to allow", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return fallback;
    }
  }

  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    const key = `entitlements:module:${orgId}:${moduleKey}`;
    return this.cache.cached(key, async () => {
      const row = await this.safeRead(
        () =>
          this.db.query.orgModules.findFirst({
            where: and(eq(orgModules.orgId, orgId), eq(orgModules.moduleKey, moduleKey)),
          }),
        undefined,
      );
      if (row === undefined) return true;
      return row?.enabled ?? true;
    }, 30);
  }

  async enabledModules(orgId: string): Promise<string[]> {
    const key = `entitlements:modules:${orgId}`;
    return this.cache.cached(key, async () => {
      const rows = await this.safeRead(
        () =>
          this.db.query.orgModules.findMany({
            where: and(eq(orgModules.orgId, orgId), eq(orgModules.enabled, true)),
          }),
        [] as Array<{ moduleKey: string; enabled: boolean }>,
      );
      return rows.map((r) => r.moduleKey);
    }, 30);
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    enabledBy: string,
  ): Promise<void> {
    await this.db
      .insert(orgModules)
      .values({ orgId, moduleKey, enabled, enabledBy })
      .onConflictDoUpdate({
        target: [orgModules.orgId, orgModules.moduleKey],
        set: { enabled, enabledBy },
      });
    await this.cache.invalidate(`entitlements:module:${orgId}:${moduleKey}`);
    await this.cache.invalidate(`entitlements:modules:${orgId}`);
  }

  async listModules(orgId: string): Promise<Array<{ moduleKey: string; enabled: boolean }>> {
    const rows = await this.safeRead(
      () =>
        this.db.query.orgModules.findMany({
          where: eq(orgModules.orgId, orgId),
          columns: { moduleKey: true, enabled: true },
          limit: 100,
        }),
      [],
    );
    return rows;
  }
}
