import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { moduleOwnerships, modulesCatalog, orgModules, organizationMembers, organizations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { CacheService } from "../../common/cache/cache.service";
import { PLAN_LOCKED_MODULES } from "../billing/core/plan-entitlements.constants";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import { ADMINISTRABLE_MODULES, MODULE_CATALOG } from "../../common/rbac/module-vocabulary";
import {
  coreModuleIds,
  isCoreModuleKey,
  moduleIdFromStored,
} from "../../common/rbac/module-registry";
import { moduleAvailabilityResolver, type ModuleAvailabilityResolver } from "../../common/rbac/module-availability";
import { commitAccessChange } from "../../common/rbac/access-mutation-commit";
import { ACCESS_MANAGED_MODULES } from "../rbac/permissions";
import { assignModuleOwnerRole } from "../ownership/module-owner-role.helper";
import { isUndefinedTable } from "../../common/db/postgres-error";

export { MODULE_CATALOG };

// Keep this export stable for existing callers while the registry owns the
// implementation. Availability and delegation are deliberately separate facts.
export { isCoreModuleKey } from "../../common/rbac/module-registry";

const OWNERSHIP_MANAGED_MODULES = new Set<string>(ACCESS_MANAGED_MODULES);

export interface ModuleStatus {
  moduleKey: string;
  enabled: boolean;
  core?: true;
}

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (isUndefinedTable(error)) return true;
  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("does not exist")
  ) {
    return true;
  }
  if ("cause" in error) return isMissingRelationError(error.cause);
  return false;
}

interface ModuleMapEntry {
  map: Record<string, boolean>;
  expiresAt: number;
}

const MODULE_MAP_LOCAL_TTL_MS = 15_000;

@Injectable()
export class EntitlementsService implements OnModuleInit {
  private missingTableLogged = false;
  private readonly moduleMapCache = new Map<string, ModuleMapEntry>();
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.db.query.modulesCatalog.findMany({
        where: eq(modulesCatalog.isCore, true),
        columns: { moduleKey: true },
        limit: 100,
      });
      const declared = new Set(coreModuleIds());
      const stored = new Set(rows.map((r) => r.moduleKey));
      const missingFromCatalog = [...declared].filter((key) => !stored.has(key));
      const extraInCatalog = [...stored].filter((key) => !declared.has(key));
      if (missingFromCatalog.length > 0 || extraInCatalog.length > 0)
        logger.warn(
          "entitlements: modules_catalog disagrees with the module registry about which modules are core",
          { missingFromCatalog, extraInCatalog },
        );
    } catch {
      logger.warn("entitlements: modules_catalog unavailable at init, using compile-time core fallback");
    }
  }

  private async safeRead<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
      if (!this.missingTableLogged) {
        this.missingTableLogged = true;
        logger.warn(
          "entitlements: org_modules table missing, denying gated module access",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return fallback;
    }
  }

  async getModuleMap(orgId: string): Promise<Record<string, boolean>> {
    const local = this.moduleMapCache.get(orgId);
    if (local && local.expiresAt > Date.now()) return local.map;

    const map = await this.cache.cachedForOrg(
      orgId,
      "entitlements:modules",
      () =>
        runInTenantTransaction(
          this.db,
          async () => {
            const rows = await this.safeRead(
              () =>
                this.db.query.orgModules.findMany({
                  where: eq(orgModules.orgId, orgId),
                  limit: 100,
                }),
              [],
            );
            const result: Record<string, boolean> = {};
            for (const row of rows)
              result[moduleIdFromStored(row.moduleKey)] = row.enabled;
            return result;
          },
          { orgId },
        ),
      30,
    );
    this.moduleMapCache.set(orgId, {
      map,
      expiresAt: Date.now() + MODULE_MAP_LOCAL_TTL_MS,
    });
    return map;
  }

  async isModuleEnabled(orgId: string, rawModuleKey: string): Promise<boolean> {
    const moduleKey = moduleIdFromStored(rawModuleKey);
    if (isCoreModuleKey(moduleKey)) return true;
    const map = await this.getModuleMap(orgId);
    return map[moduleKey] ?? false;
  }

  /** Absent stays `undefined` so availability can tell "no row" from "disabled" and reach the plan check. */
  async getModuleState(
    orgId: string,
    rawModuleKey: string,
  ): Promise<boolean | undefined> {
    const moduleKey = moduleIdFromStored(rawModuleKey);
    if (isCoreModuleKey(moduleKey)) return true;
    const map = await this.getModuleMap(orgId);
    return map[moduleKey];
  }

  isCoreModule(moduleKey: string): boolean {
    return isCoreModuleKey(moduleKey);
  }

  async getPlanLockedModules(orgId: string): Promise<readonly string[]> {
    const { tier } = await this.planLimits.resolveTier(orgId);
    return PLAN_LOCKED_MODULES[tier];
  }

  buildModuleAvailabilityResolver(
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
    getUserDeniedModules?: (orgId: string, userId: string) => Promise<Set<string>>,
  ): ModuleAvailabilityResolver {
    return moduleAvailabilityResolver(
      {
        isCoreModule: (moduleKey) => this.isCoreModule(moduleKey),
        getModuleMap,
        getPlanLockedModules: (orgId) => this.getPlanLockedModules(orgId),
      },
      getUserDeniedModules ? { getUserDeniedModules } : undefined,
    );
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    enabledBy: string,
  ): Promise<void> {
    if (this.isCoreModule(moduleKey)) {
      throw new BadRequestException(
        `Module "${moduleKey}" is always-on and cannot be toggled`,
      );
    }
    if (enabled) {
      const { tier } = await this.planLimits.resolveTier(orgId);
      if (PLAN_LOCKED_MODULES[tier].includes(moduleKey)) {
        const label = moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1);
        throw new ForbiddenException(
          `The ${label} module requires a paid plan. Upgrade to enable it.`,
        );
      }
    }
    await runInTenantTransaction(this.db, async (tx) => {
      await tx
        .insert(orgModules)
        .values({ orgId, moduleKey, enabled, enabledBy })
        .onConflictDoUpdate({
          target: [orgModules.orgId, orgModules.moduleKey],
          set: { enabled, enabledBy },
        });

      if (enabled && OWNERSHIP_MANAGED_MODULES.has(moduleKey)) {
        const [orgRow] = await tx
          .select({ ownerMembershipId: organizations.ownerMembershipId })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);

        const ownerMembershipId = orgRow?.ownerMembershipId;
        if (ownerMembershipId !== null && ownerMembershipId !== undefined) {
          await tx
            .insert(moduleOwnerships)
            .values({ orgId, moduleKey, ownerMembershipId })
            .onConflictDoNothing();

          await assignModuleOwnerRole(tx, orgId, moduleKey, ownerMembershipId);
        }
      }

      await commitAccessChange(tx, orgId);
    }, { orgId });

    this.moduleMapCache.delete(orgId);
    await this.cache.invalidateForOrg(orgId, `entitlements:module:${moduleKey}`);
    await this.cache.invalidateForOrg(orgId, "entitlements:modules");

    const bustSessions = (): Promise<void> => this.bustActiveMemberSessions(orgId);
    if (!registerAfterCommit(bustSessions)) await bustSessions();
  }

  /**
   * Every ACTIVE member's session carries `enabledModules`, so one module toggle
   * makes every member's session stale — not just the actor's. Leaving them is
   * revoked access surviving revocation for the length of the session TTL.
   *
   * There is no generation counter to bump instead. `user:session:<userId>` is a
   * per-user key with no organisation segment — deliberately, because the payload
   * spans organisations — and it is read through `cache.cached`, not
   * `cachedVersioned`, so `invalidateNamespaceForOrg` cannot reach it. Naming the
   * members' keys is the only path, and the cost of doing so is bounded three
   * ways rather than left to grow with the tenant:
   *
   *   · **Off the request thread.** `registerAfterCommit` defers the whole scan
   *     until the toggle has committed; the interceptor runs each hook in its own
   *     tenant transaction, so the request's pooled connection is already back.
   *     With no ambient request context (a background caller, a unit test) the
   *     hook runs inline rather than being dropped.
   *   · **No ceiling.** The scan was one `.limit(10000)`, which silently never
   *     invalidated member 10,001 onward. Keyset paging on the membership id
   *     removes the ceiling: a 10,000-member org is 20 indexed reads of 500 rows.
   *   · **Bounded fan-out.** `invalidateMany` collapses each page into variadic
   *     `DEL`s, so 10,000 members cost ~40 Redis commands, not 10,000. A
   *     `members.map((m) => cache.invalidate(...))` reads as batched and is not.
   *
   * A crash between the commit and the bust costs at most the 60s session TTL and
   * is re-drivable from state already stored, which is why this is an
   * after-commit hook (backend §4 mechanism 3) and not an outbox event.
   */
  private static readonly SESSION_BUST_PAGE = 500;

  private async bustActiveMemberSessions(orgId: string): Promise<void> {
    const page = EntitlementsService.SESSION_BUST_PAGE;
    let afterMembershipId = 0;
    for (;;) {
      const members = await runInTenantTransaction(
        this.db,
        (tx) =>
          tx
            .select({
              membershipId: organizationMembers.id,
              userId: organizationMembers.userId,
            })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "ACTIVE"),
                gt(organizationMembers.id, afterMembershipId),
              ),
            )
            .orderBy(asc(organizationMembers.id))
            .limit(page),
        { orgId },
      );
      if (members.length === 0) return;

      await this.cache.invalidateMany(
        members.map((member) => CACHE_KEYS.userSession(member.userId)),
      );

      const last = members[members.length - 1];
      if (last === undefined || members.length < page) return;
      afterMembershipId = last.membershipId;
    }
  }

  /**
   * Effective on/off state of every toggleable catalog module for an org.
   *
   * Deny-by-default: a module with no `org_modules` row is NOT enabled, so an
   * org runs exactly what it turned on during setup or in Settings → Modules.
   * This mirrors `isModuleEnabled` (the guard) so the modules a user is shown
   * and the modules the API actually serves can never disagree.
   */
  async getEffectiveModuleMap(orgId: string): Promise<Record<string, boolean>> {
    const map = await this.getModuleMap(orgId);
    const effective: Record<string, boolean> = {};
    for (const moduleKey of ADMINISTRABLE_MODULES) {
      effective[moduleKey] = this.isCoreModule(moduleKey)
        ? true
        : (map[moduleKey] ?? false);
    }
    return effective;
  }

  async listModules(orgId: string): Promise<ModuleStatus[]> {
    const effective = await this.getEffectiveModuleMap(orgId);
    return ADMINISTRABLE_MODULES.map((moduleKey): ModuleStatus =>
      this.isCoreModule(moduleKey)
        ? { moduleKey, enabled: true, core: true }
        : { moduleKey, enabled: effective[moduleKey] ?? false },
    );
  }
}
