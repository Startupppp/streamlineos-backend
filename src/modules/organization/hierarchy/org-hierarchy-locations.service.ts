import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  orgUnits,
  type OrgUnitMetadata,
} from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgLocationInput,
  ListQueryInput,
  UpdateOrgLocationInput,
} from "./dto/org-hierarchy.schemas";
import {
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";
import {
  getOrgUnitListFilter,
  getOrgUnitRowFilter,
  getOrgUnitWriteFilter,
  recordOrgUnitAudit,
} from "./org-unit-crud";

const KIND = "LOCATION";

const ORG_LOCATION_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  status: orgUnits.status,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const locationAddressSearch = (pattern: string) =>
  sql<boolean>`coalesce(${orgUnits.metadata}->>'address', '') ilike ${pattern}`;

/** Locations carry no user-supplied code; it is derived from the name. */
function toLocationCode(name: string) {
  return name.substring(0, 8).toUpperCase().replace(/\s/g, "");
}

type OrgLocationRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "name"
  | "status"
  | "metadata"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

export function toOrgLocation(row: OrgLocationRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    type: row.metadata?.locationType ?? "OFFICE",
    address: row.metadata?.address ?? null,
    latitude:
      row.metadata?.latitude != null ? String(row.metadata.latitude) : null,
    longitude:
      row.metadata?.longitude != null ? String(row.metadata.longitude) : null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class OrgHierarchyLocationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listLocations(orgId: string, query: ListQueryInput) {
    const rows = await this.db
      .select(ORG_LOCATION_COLUMNS)
      .from(orgUnits)
      .where(
        getOrgUnitListFilter({
          orgId,
          kind: KIND,
          query,
          searchExtension: locationAddressSearch,
        }),
      )
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(query.limit + 1);
    return toOrgUnitCursorPage(rows, query.limit, toOrgLocation);
  }

  private async getLocationRow(
    orgId: string,
    id: string,
  ): Promise<OrgLocationRow | null> {
    const [row] = await this.db
      .select(ORG_LOCATION_COLUMNS)
      .from(orgUnits)
      .where(getOrgUnitRowFilter(orgId, KIND, id))
      .limit(1);
    return row ?? null;
  }

  async getLocation(orgId: string, id: string) {
    const row = await this.getLocationRow(orgId, id);
    return row ? toOrgLocation(row) : null;
  }

  async createLocation(
    orgId: string,
    userId: string,
    body: CreateOrgLocationInput,
  ) {
    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: KIND,
        name: body.name,
        code: toLocationCode(body.name),
        metadata: {
          locationType: body.type ?? "OFFICE",
          ...(body.address !== undefined
            ? { address: body.address ?? undefined }
            : {}),
          ...(body.latitude !== undefined && body.latitude !== null
            ? { latitude: body.latitude }
            : {}),
          ...(body.longitude !== undefined && body.longitude !== null
            ? { longitude: body.longitude }
            : {}),
        },
      })
      .returning(ORG_LOCATION_COLUMNS);

    if (!row) throw new Error("Failed to create location");

    await recordOrgUnitAudit(this.audit, {
      action: "org.location.created",
      userId,
      orgId,
      targetId: row.id,
    });

    return toOrgLocation(row);
  }

  async updateLocation(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgLocationInput,
  ) {
    const existing = await this.getLocationRow(orgId, id);
    if (!existing) throw new NotFoundException("Location not found");

    const existingMeta: OrgUnitMetadata = {
      locationType: "OFFICE",
      ...(existing.metadata ?? {}),
    };

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.status !== undefined && { status: body.status }),
        metadata: {
          ...existingMeta,
          ...(body.type !== undefined && { locationType: body.type }),
          ...(body.address !== undefined
            ? { address: body.address ?? undefined }
            : {}),
          ...(body.latitude !== undefined
            ? { latitude: body.latitude ?? undefined }
            : {}),
          ...(body.longitude !== undefined
            ? { longitude: body.longitude ?? undefined }
            : {}),
        },
      })
      .where(getOrgUnitWriteFilter(orgId, KIND, id))
      .returning(ORG_LOCATION_COLUMNS);

    if (!row) throw new NotFoundException("Location not found");

    await recordOrgUnitAudit(this.audit, {
      action: "org.location.updated",
      userId,
      orgId,
      targetId: id,
    });

    return toOrgLocation(row);
  }
}
