import { HttpException, HttpStatus } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { isKnownRegion, type RegionDefinition, type RegionTopology } from "./region.config";
import { isPlaceable, regionForCountry } from "./region-placement";
import {
  decidePlacement,
  placementFromRegion,
  type OrganizationPlacement,
  type PlacementIntent,
} from "./placement";
import {
  signPlacement,
  verifyPlacement,
  type PlacementKeyring,
  type SignedPlacementRejection,
} from "./placement-signature";

/** One region's live handles. */
export interface RegionBinding {
  readonly definition: RegionDefinition;
  readonly db: Db;
}

/** Reads an organisation's placement from the control plane. Null means unplaced. */
export type OrgRegionLookup = (
  orgId: string,
) => Promise<OrganizationPlacement | string | null>;

/** Region is effectively immutable per organisation; moving one is a migration. */
export const PLACEMENT_CACHE_TTL_MS = 10 * 60 * 1000;

export interface PlacementCacheEntry {
  readonly placement: OrganizationPlacement;
  readonly expiresAt: number;
  readonly token: string | null;
}

export class ControlPlaneUnavailableError extends HttpException {
  constructor(orgId: string, readonly cause: unknown) {
    super(
      {
        code: "CONTROL_PLANE_UNAVAILABLE",
        message:
          `Placement for organisation ${orgId} is not cached and the control plane is ` +
          `unreachable. Refusing rather than guessing which cell owns it.`,
        details: { retryable: true, retryAfterMs: 2_000 },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = "ControlPlaneUnavailableError";
  }
}

export class SignedPlacementRejectedError extends HttpException {
  constructor(readonly reason: SignedPlacementRejection) {
    super(
      {
        code: "SIGNED_PLACEMENT_REJECTED",
        message: `The presented placement could not be trusted: ${reason}.`,
        details: { retryable: reason === "EXPIRED", reason },
      },
      HttpStatus.UNAUTHORIZED,
    );
    this.name = "SignedPlacementRejectedError";
  }
}

export class PlacementRefusedError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
    readonly placement: OrganizationPlacement,
  ) {
    super(
      {
        code,
        message,
        details: {
          retryable,
          retryAfterMs,
          cellId: placement.cellId,
          placementVersion: placement.placementVersion,
          status: placement.status,
        },
      },
      retryable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT,
    );
    this.name = "PlacementRefusedError";
  }
}

export class RegionRegistry {
  protected readonly cache = new Map<string, PlacementCacheEntry>();

  constructor(
    private readonly topology: RegionTopology,
    private readonly bindings: ReadonlyMap<string, RegionBinding>,
    private readonly lookupOrgRegion: OrgRegionLookup,
    protected readonly now: () => number = () => Date.now(),
    private readonly keyring: PlacementKeyring | null = null,
  ) {}

  get primary(): string {
    return this.topology.primary;
  }

  get keys(): readonly string[] {
    return Object.keys(this.topology.regions);
  }

  cellFor(region: string): string {
    return this.bindingFor(region).definition.cell.cellId;
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
  async placementForOrg(orgId: string): Promise<OrganizationPlacement> {
    if (!orgId) throw new Error("[region] regionForOrg: orgId must be a non-empty string");

    const cached = this.readCache(orgId);
    if (cached) return cached;

    const placement = await this.resolvePlacement(orgId);
    this.writeCache(orgId, placement);
    return placement;
  }

  async regionForOrg(orgId: string): Promise<string> {
    return (await this.placementForOrg(orgId)).region;
  }

  async admittedPlacementForOrg(
    orgId: string,
    intent: PlacementIntent,
  ): Promise<OrganizationPlacement> {
    const placement = await this.placementForOrg(orgId);
    const decision = decidePlacement(placement, intent, this.now());

    if (!decision.admitted)
      throw new PlacementRefusedError(
        decision.code,
        decision.message,
        decision.retryable,
        decision.retryAfterMs,
        placement,
      );

    return placement;
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

  async cacheKeyPrefixForOrg(orgId: string): Promise<string | null> {
    const region = await this.regionForOrg(orgId);
    return this.bindingFor(region).definition.cell.cacheKeyPrefix ?? null;
  }

  /** Call when an organisation is placed or moved. */
  forget(orgId: string): void {
    this.cache.delete(orgId);
  }

  private async lookup(
    orgId: string,
  ): Promise<OrganizationPlacement | string | null> {
    try {
      return await this.lookupOrgRegion(orgId);
    } catch (error) {
      throw new ControlPlaneUnavailableError(orgId, error);
    }
  }

  forgetVersionsBelow(orgId: string, placementVersion: number): void {
    const entry = this.cache.get(orgId);
    if (entry && entry.placement.placementVersion < placementVersion)
      this.cache.delete(orgId);
  }

  async signedPlacementFor(
    orgId: string,
  ): Promise<{ placement: OrganizationPlacement; token: string | null }> {
    const placement = await this.placementForOrg(orgId);
    return { placement, token: this.cache.get(orgId)?.token ?? null };
  }

  acceptSignedPlacement(token: string): OrganizationPlacement {
    if (!this.keyring) throw new SignedPlacementRejectedError("UNKNOWN_KEY");

    const verdict = verifyPlacement(token, this.keyring, this.now());
    if (!verdict.ok) throw new SignedPlacementRejectedError(verdict.reason);

    const cached = this.cache.get(verdict.placement.organizationId);
    if (cached && cached.placement.placementVersion > verdict.placement.placementVersion)
      throw new SignedPlacementRejectedError("EXPIRED");

    return verdict.placement;
  }

  protected readCache(orgId: string): OrganizationPlacement | null {
    const cached = this.cache.get(orgId);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      this.cache.delete(orgId);
      return null;
    }
    if (this.keyring && cached.token !== null) {
      const verdict = verifyPlacement(cached.token, this.keyring, this.now());
      if (!verdict.ok) {
        this.cache.delete(orgId);
        return null;
      }
      return verdict.placement;
    }
    return cached.placement;
  }

  protected writeCache(orgId: string, placement: OrganizationPlacement): void {
    const expiresAt = this.now() + PLACEMENT_CACHE_TTL_MS;
    this.cache.set(orgId, {
      placement,
      expiresAt,
      token: this.keyring
        ? signPlacement(placement, expiresAt, this.keyring.current)
        : null,
    });
  }

  protected async resolvePlacement(orgId: string): Promise<OrganizationPlacement> {
    const raw = await this.lookup(orgId);

    if (raw === null)
      throw new Error(
        `[region] organisation ${orgId} has no region. It must be placed before its data can be reached.`,
      );

    const region = typeof raw === "string" ? raw : raw.region;

    if (!isKnownRegion(this.topology, region))
      throw new Error(
        `[region] organisation ${orgId} is placed in "${region}", which this deployment does not serve. ` +
          `Configured: ${this.keys.join(", ") || "none"}.`,
      );

    const binding = this.bindingFor(region);
    const placement =
      typeof raw === "string"
        ? placementFromRegion(orgId, region, binding.definition.storage.region)
        : raw;

    if (placement.cellId !== binding.definition.cell.cellId)
      throw new Error(
        `[region] organisation ${orgId} is placed in cell "${placement.cellId}", but region ` +
          `"${region}" here is cell "${binding.definition.cell.cellId}". Serving it would mean ` +
          `two cells owning one organisation.`,
      );

    return placement;
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
 * The fallback region outside a booted application (unit tests, seeds). It
 * matches both PRIMARY_REGION's default and the value the migration backfills
 * onto existing rows. Creation paths call `chooseRegionForNewOrg`, which selects
 * a measured cell and records why.
 */
export const DEFAULT_REGION = "primary";

/**
 * The region an organisation being created is placed in.
 *
 * Placement-by-lookup cannot answer this — there is no placement row yet — so
 * signup asks the billing country instead, and `withNewOrgInRegion` carries the
 * answer into the transaction that writes the row.
 */
export function regionForNewOrg(country?: string | null): string {
  if (!hasRegionRegistry()) return DEFAULT_REGION;

  const registry = getRegionRegistry();
  if (!country?.trim()) return registry.primary;

  // A country mapping to a region this deployment does not serve falls back to
  // the primary rather than failing. Placing a tenant somewhere unreachable
  // fails at its first query instead of at signup, which is the wrong end — and
  // refusing the signup outright over an unserved region turns a customer into a
  // support ticket.
  const placement = regionForCountry(country);
  return isPlaceable(placement, registry.keys) ? placement.region : registry.primary;
}
