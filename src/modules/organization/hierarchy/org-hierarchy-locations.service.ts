import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgLocationInput,
  UpdateOrgLocationInput,
} from "./dto/org-hierarchy.schemas";

@Injectable()
export class OrgHierarchyLocationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  listLocations(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.orgUnits(orgId, "LOCATION"),
      () =>
        this.db
          .select()
          .from(orgUnits)
          .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION"), isNull(orgUnits.deletedAt))),
      CACHE_TTL.MEDIUM,
    );
  }

  async getLocation(orgId: string, id: string) {
    return (
      (await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "LOCATION"),
        ),
      })) ?? null
    );
  }

  async createLocation(orgId: string, userId: string, body: CreateOrgLocationInput) {
    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "LOCATION",
        name: body.name,
        code: body.name.substring(0, 8).toUpperCase().replace(/\s/g, ""),
        metadata: {
          locationType: body.type ?? "OFFICE",
          ...(body.address !== undefined && { address: body.address }),
          ...(body.latitude !== undefined && { latitude: body.latitude }),
          ...(body.longitude !== undefined && { longitude: body.longitude }),
        },
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "LOCATION"));
    await this.audit.log({ action: "org.location.created", userId, orgId, targetId: row!.id, targetType: "org_unit" });

    return row;
  }

  async updateLocation(orgId: string, userId: string, id: string, body: UpdateOrgLocationInput) {
    const existing = await this.getLocation(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    const existingMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.status !== undefined && { status: body.status }),
        metadata: {
          ...existingMeta,
          ...(body.type !== undefined && { locationType: body.type }),
          ...(body.address !== undefined && { address: body.address }),
          ...(body.latitude !== undefined && { latitude: body.latitude ?? undefined }),
          ...(body.longitude !== undefined && { longitude: body.longitude ?? undefined }),
        },
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION")))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "LOCATION"));
    await this.audit.log({ action: "org.location.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return row;
  }

  async deleteLocation(orgId: string, userId: string, id: string) {
    const existing = await this.getLocation(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION")));

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "LOCATION"));
    await this.audit.log({ action: "org.location.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }
}
