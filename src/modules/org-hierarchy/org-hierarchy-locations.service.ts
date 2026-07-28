import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgLocations } from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
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
      CACHE_KEYS.orgLocations(orgId),
      () =>
        this.db
          .select()
          .from(orgLocations)
          .where(eq(orgLocations.orgId, orgId)),
      CACHE_TTL.MEDIUM,
    );
  }

  async getLocation(orgId: string, id: string) {
    return (
      (await this.db.query.orgLocations.findFirst({
        where: and(eq(orgLocations.id, id), eq(orgLocations.orgId, orgId)),
      })) ?? null
    );
  }

  async createLocation(orgId: string, userId: string, body: CreateOrgLocationInput) {
    const [row] = await this.db
      .insert(orgLocations)
      .values({
        id: randomUUID(),
        orgId,
        name: body.name,
        type: body.type ?? "OFFICE",
        address: body.address,
        latitude: body.latitude?.toString(),
        longitude: body.longitude?.toString(),
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgLocations(orgId));
    await this.audit.log({ action: "org.location.created", userId, orgId, targetId: row!.id, targetType: "org_location" });

    return row;
  }

  async updateLocation(orgId: string, userId: string, id: string, body: UpdateOrgLocationInput) {
    const existing = await this.getLocation(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    const [row] = await this.db
      .update(orgLocations)
      .set({
        ...body,
        latitude: body.latitude?.toString() ?? (body.latitude === null ? null : undefined),
        longitude: body.longitude?.toString() ?? (body.longitude === null ? null : undefined),
      })
      .where(and(eq(orgLocations.id, id), eq(orgLocations.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.orgLocations(orgId));
    await this.audit.log({ action: "org.location.updated", userId, orgId, targetId: id, targetType: "org_location" });

    return row;
  }

  async deleteLocation(orgId: string, userId: string, id: string) {
    const existing = await this.getLocation(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    await this.db
      .delete(orgLocations)
      .where(and(eq(orgLocations.id, id), eq(orgLocations.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.orgLocations(orgId));
    await this.audit.log({ action: "org.location.deleted", userId, orgId, targetId: id, targetType: "org_location" });
  }
}
