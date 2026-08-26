import type { Db } from "../../db/drizzle.types";
import { isKnownRegion, type RegionDefinition, type RegionTopology } from "./region.config";
import { isPlaceable, regionForCountry } from "./region-placement";

/** One region's live handles. */
export interface RegionBinding {
  readonly definition: RegionDefinition;
  readonly db: Db;
}

/** Reads an organisation's region from the control plane. Null means unplaced. */
export type OrgRegionLookup = (orgId: string) => Promise<string | null>;

/** Region is effectively immutable per organisation; moving one is a migration. */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  region: string;
  expiresAt: number;
}

export class RegionRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly topology: RegionTopology,
    private readonly bindings: ReadonlyMap<string, RegionBinding>,
    private readonly lookupOrgRegion: OrgRegionLookup,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get primary(): string {
    return this.topology.primary;
  }

  get keys(): readonly string[] {
    return Object.keys(this.topology.regions);
  }

  /**
   * The region an organisation's data lives in.
   *
   * Fails closed in both directions. An organisation nobody has placed, or one
   * placed in a region this deployment does not serve, raises rather than
   * quietly falling back to the primary — a silent fallback is how one tenant's
   * rows end up written into another region's database, which is the single
   * failure this whole seam exists to make impossible.
   */
  async regionForOrg(orgId: string): Promise<string> {
    if (!orgId) throw new Error("[region] regionForOrg: orgId must be a non-empty string");

    const cached = this.cache.get(orgId);
    if (cached && cached.expiresAt > this.now()) return cached.region;

    const region = await this.lookupOrgRegion(orgId);

    if (region === null)
      throw new Error(
        `[region] organisation ${orgId} has no region. It must be placed before its data can be reached.`,
      );

    if (!isKnownRegion(this.topology, region))
      throw new Error(
        `[region] organisation ${orgId} is placed in "${region}", which this deployment does not serve. ` +
          `Configured: ${this.keys.join(", ") || "none"}.`,
      );

    this.cache.set(orgId, { region, expiresAt: this.now() + CACHE_TTL_MS });
    return region;
  }

  bindingFor(region: string): RegionBinding {
    const binding = this.bindings.get(region);
    if (!binding)
      throw new Error(
        `[region] no connection configured for region "${region}". ` +
          `Configured: ${this.keys.join(", ") || "none"}.`,
      );
    return binding;
  }

  async dbForOrg(orgId: string): Promise<Db> {
    return this.bindingFor(await this.regionForOrg(orgId)).db;
  }

  async storageForOrg(orgId: string): Promise<RegionDefinition["storage"]> {
    return this.bindingFor(await this.regionForOrg(orgId)).definition.storage;
  }

  /** Call when an organisation is placed or moved. */
  forget(orgId: string): void {
    this.cache.delete(orgId);
  }
}

/**
 * Module-level, because `withTenant` is a plain function called from request
 * interceptors, background sweeps and cron alike — the same reason
 * `poolTelemetry` is a singleton. Putting resolution behind an injectable would
 * mean threading it through every one of those callers, and a caller that
 * forgot would silently reach the wrong database.
 */
let active: RegionRegistry | undefined;

export function setRegionRegistry(registry: RegionRegistry): void {
  active = registry;
}

export function clearRegionRegistry(): void {
  active = undefined;
}

export function getRegionRegistry(): RegionRegistry {
  if (!active)
    throw new Error(
      "[region] registry not configured. RegionModule must be registered before any tenant transaction opens.",
    );
  return active;
}

export function hasRegionRegistry(): boolean {
  return active !== undefined;
}

/**
 * The region a newly created organisation is placed in.
 *
 * Every creation path calls this rather than writing a literal, so placement has
 * one rule. Outside a booted application (unit tests, seeds) it falls back to the
 * documented default, which matches both PRIMARY_REGION's default and the value
 * the migration backfills onto existing rows.
 */
export const DEFAULT_REGION = "primary";

export function regionForNewOrg(country?: string | null): string {
  if (!hasRegionRegistry()) return DEFAULT_REGION;

  const registry = getRegionRegistry();
  if (!country?.trim()) return registry.primary;

  // A country that maps to a region this deployment does not serve falls back to
  // the primary rather than failing. Placing a tenant somewhere unreachable
  // fails at its first query instead of at signup, which is the wrong end -- and
  // refusing the signup outright over an unserved region turns a customer into a
  // support ticket.
  const placement = regionForCountry(country);
  return isPlaceable(placement, registry.keys) ? placement.region : registry.primary;
}
