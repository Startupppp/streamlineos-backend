import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  orgUnits,
  type OrgUnitMetadata,
} from "../../../db/schema";
import type {
  CreateOrgLocationInput,
  ListQueryInput,
  UpdateOrgLocationInput,
} from "./dto/org-hierarchy.schemas";
import {
  OrgUnitCrudService,
  type OrgUnitCrudAdapter,
} from "./org-unit-crud";

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

function toLocationCode(name: string) {
  return name.substring(0, 8).toUpperCase().replace(/\s/g, "");
}

function toLocationMetadata(input: CreateOrgLocationInput): OrgUnitMetadata {
  return {
    locationType: input.type ?? "OFFICE",
    ...(input.address !== undefined
      ? { address: input.address ?? undefined }
      : {}),
    ...(input.latitude !== undefined && input.latitude !== null
      ? { latitude: input.latitude }
      : {}),
    ...(input.longitude !== undefined && input.longitude !== null
      ? { longitude: input.longitude }
      : {}),
  };
}

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

const LOCATION_ADAPTER: OrgUnitCrudAdapter<
  CreateOrgLocationInput,
  UpdateOrgLocationInput,
  OrgLocationRow,
  OrgLocationRow,
  ReturnType<typeof toOrgLocation>
> = {
  kind: "LOCATION",
  label: "Location",
  auditName: "org.location",
  searchExtension: (pattern) =>
    sql<boolean>`coalesce(${orgUnits.metadata}->>'address', '') ilike ${pattern}`,
  code: {
    create: (input) => toLocationCode(input.name),
    unique: false,
  },
  listRows: async (db, plan) =>
    db
      .select(ORG_LOCATION_COLUMNS)
      .from(orgUnits)
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit),
  readRow: async (db, where) => {
    const [row] = await db
      .select(ORG_LOCATION_COLUMNS)
      .from(orgUnits)
      .where(where)
      .limit(1);
    return row ?? null;
  },
  createValues: (input) => ({
    name: input.name,
    metadata: toLocationMetadata(input),
  }),
  updateValues: (input, existing) => {
    const metadata: OrgUnitMetadata = {
      locationType: "OFFICE",
      ...(existing.metadata ?? {}),
      ...(input.type !== undefined ? { locationType: input.type } : {}),
      ...(input.address !== undefined
        ? { address: input.address ?? undefined }
        : {}),
      ...(input.latitude !== undefined
        ? { latitude: input.latitude ?? undefined }
        : {}),
      ...(input.longitude !== undefined
        ? { longitude: input.longitude ?? undefined }
        : {}),
    };
    return {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      metadata,
    };
  },
  toOutput: toOrgLocation,
  toListOutput: toOrgLocation,
  toWriteOutput: toOrgLocation,
};

@Injectable()
export class OrgHierarchyLocationsService {
  constructor(private readonly crud: OrgUnitCrudService) {}

  listLocations(orgId: string, query: ListQueryInput) {
    return this.crud.list(LOCATION_ADAPTER, orgId, query);
  }

  getLocation(orgId: string, id: string) {
    return this.crud.get(LOCATION_ADAPTER, orgId, id);
  }

  createLocation(
    orgId: string,
    userId: string,
    body: CreateOrgLocationInput,
  ) {
    return this.crud.create(LOCATION_ADAPTER, orgId, userId, body);
  }

  updateLocation(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgLocationInput,
  ) {
    return this.crud.update(LOCATION_ADAPTER, orgId, userId, id, body);
  }
}
