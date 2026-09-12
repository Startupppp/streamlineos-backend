import { z } from "zod";
import { nullableWireDate, wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";
import { createReservationResponseSchema } from "../../stock/dto/stock-response.schemas";

/**
 * B1 — what the project surfaces actually put on the wire.
 *
 * Two shapes recur and are named once: the project header row as
 * `inv_projects` stores it, and the requirement row as `inv_project_requirements`
 * stores it. Both come back from `.returning()` on the writes, so they are the
 * whole row rather than a projection, and `date` columns (`startsOn`, `endsOn`,
 * `requiredBy`) arrive as text while `timestamp` columns arrive as `Date`.
 */
const projectRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  code: z.string(),
  name: z.string(),
  clientId: z.number().int().nullable(),
  siteAddress: z.string().nullable(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  siteContactName: z.string().nullable(),
  siteContactPhone: z.string().nullable(),
  status: z.string(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const requirementRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  requiredQty: z.string(),
  fulfilledQty: z.string(),
  requiredBy: z.string().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `RequirementCoverage` — derived on every read, never stored. */
const coverageSchema = z.object({
  requirementId: z.number().int(),
  requiredQty: z.string(),
  reservedQty: z.string(),
  fulfilledQty: z.string(),
  shortfallQty: z.string(),
  availableQty: z.string(),
  atRisk: z.boolean(),
  riskReason: z.string().nullable(),
});

export const listProjectsResponseSchema = itemsPagedSchema(
  z.object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    clientId: z.number().int().nullable(),
    city: z.string().nullable(),
    zone: z.string().nullable(),
    status: z.string(),
    startsOn: z.string().nullable(),
    endsOn: z.string().nullable(),
    siteContactName: z.string().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
    openRequirements: z.number().int(),
    overdueRequirements: z.number().int(),
  }),
);

/**
 * The single-project read is the header's own columns — no `orgId`, `createdBy`
 * or `deletedAt`, because `getProject` names its projection — plus every
 * requirement joined to its catalogue and dark-store labels.
 */
export const getProjectResponseSchema = projectRowSchema
  .omit({ orgId: true, createdBy: true, deletedAt: true })
  .extend({
    requirements: z.array(
      requirementRowSchema
        .omit({ orgId: true, createdBy: true, updatedAt: true })
        .extend({
          variantSku: z.string(),
          variantName: z.string(),
          productId: z.number().int(),
          productName: z.string(),
          productSku: z.string(),
          brand: z.string().nullable(),
          materialGrade: z.string().nullable(),
          dimensionLabel: z.string().nullable(),
          imageUrl: z.string().nullable(),
          leadTimeDays: z.number().int().nullable(),
          /** Left-joined: a line that names no dark store yet carries nulls here. */
          warehouseName: z.string().nullable(),
          warehouseCode: z.string().nullable(),
          warehouseZone: z.string().nullable(),
          coverage: coverageSchema.nullable(),
        }),
    ),
  });

export const createProjectResponseSchema = projectRowSchema;

export const updateProjectResponseSchema = projectRowSchema;

/** The archive write returns only what it changed. */
export const archiveProjectResponseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  deletedAt: nullableWireDate(),
});

export const createRequirementResponseSchema = requirementRowSchema;

export const updateRequirementResponseSchema = requirementRowSchema;

/**
 * The at-risk feed. `coverage` is not nullable here: the feed is the result of
 * filtering on `coverage.atRisk`, so a row without one cannot reach the caller.
 */
export const atRiskRequirementsResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    projectId: z.number().int(),
    productVariantId: z.number().int(),
    warehouseId: z.number().int().nullable(),
    requiredQty: z.string(),
    fulfilledQty: z.string(),
    requiredBy: z.string().nullable(),
    status: z.string(),
    leadTimeDays: z.number().int().nullable(),
    projectCode: z.string(),
    projectName: z.string(),
    projectZone: z.string().nullable(),
    productName: z.string(),
    variantSku: z.string(),
    coverage: coverageSchema,
  }),
);

/** Reserving hands back the reservation the engine created, unchanged. */
export const reserveRequirementResponseSchema = createReservationResponseSchema;

/** Releasing reports how many active holds it actually dropped. */
export const releaseRequirementResponseSchema = z.object({
  released: z.number().int(),
});
