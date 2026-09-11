import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

/**
 * Response contract for `OrgHierarchyController` handlers.
 *
 * List endpoints use `toOrgUnitCursorPage`, which wraps in
 * `{ data, pageInfo: { limit, hasMore, nextCursor } }` — distinct from the
 * global `cursorPageSchema` that uses `pagination`.
 *
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

/** Shared cursor-page wrapper used by hierarchy list endpoints. */
function orgUnitCursorPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pageInfo: z.object({
      limit: z.number().int(),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  });
}

/** Common timestamp + soft-delete fields on every org unit. */
const orgUnitTimestamps = {
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
};

// ─── Business Units ────────────────────────────────────────────────────────

const businessUnitItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  ...orgUnitTimestamps,
});

/** `OrgHierarchyService.listBusinessUnits` */
export const businessUnitListResponseSchema = orgUnitCursorPage(businessUnitItemSchema);

/** `OrgHierarchyService.createBusinessUnit` / `updateBusinessUnit` */
export const businessUnitResponseSchema = businessUnitItemSchema;

// ─── Branches ──────────────────────────────────────────────────────────────

const branchItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  businessUnitId: z.string().nullable(),
  managerUserId: z.string().nullable(),
  name: z.string(),
  code: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  postalCode: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  status: z.string(),
  ...orgUnitTimestamps,
});

const branchListItemSchema = branchItemSchema.extend({
  businessUnitName: z.string().nullable(),
});

/** `OrgHierarchyService.listOrgBranches` */
export const branchListResponseSchema = orgUnitCursorPage(branchListItemSchema);

/** `OrgHierarchyService.createOrgBranch` / `updateOrgBranch` */
export const branchResponseSchema = branchItemSchema;

// ─── Departments ───────────────────────────────────────────────────────────

const departmentItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  branchId: z.string().nullable(),
  headUserId: z.string().nullable(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  ...orgUnitTimestamps,
});

const departmentListItemSchema = departmentItemSchema.extend({
  branchName: z.string().nullable(),
});

/** `OrgHierarchyService.listDepartments` */
export const departmentListResponseSchema = orgUnitCursorPage(departmentListItemSchema);

/** `OrgHierarchyService.createDepartment` / `updateDepartment` */
export const departmentResponseSchema = departmentItemSchema;

// ─── Teams ─────────────────────────────────────────────────────────────────

const teamItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  departmentId: z.string().nullable(),
  leadUserId: z.string().nullable(),
  capacity: z.string().nullable(),
  ...orgUnitTimestamps,
});

const teamListItemSchema = teamItemSchema.extend({
  departmentName: z.string().nullable(),
});

/** `OrgHierarchyService.listTeams` */
export const teamListResponseSchema = orgUnitCursorPage(teamListItemSchema);

/** `OrgHierarchyService.createTeam` / `updateTeam` */
export const teamResponseSchema = teamItemSchema;

// ─── Locations ─────────────────────────────────────────────────────────────

const locationItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  type: z.string(),
  address: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  status: z.string(),
  ...orgUnitTimestamps,
});

/** `OrgHierarchyService.listLocations` */
export const locationListResponseSchema = orgUnitCursorPage(locationItemSchema);

/** `OrgHierarchyService.createLocation` / `updateLocation` */
export const locationResponseSchema = locationItemSchema;

// ─── Cost Centers ──────────────────────────────────────────────────────────

const costCenterItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  ...orgUnitTimestamps,
});

/** `OrgHierarchyService.listCostCenters` */
export const costCenterListResponseSchema = orgUnitCursorPage(costCenterItemSchema);

/** `OrgHierarchyService.createCostCenter` / `updateCostCenter` */
export const costCenterResponseSchema = costCenterItemSchema;

// ─── Hierarchy Overview ────────────────────────────────────────────────────

/** `OrgHierarchyReadService.getHierarchy` — unit counts per kind. */
export const hierarchyOverviewResponseSchema = z.object({
  businessUnits: z.number().int(),
  branches: z.number().int(),
  departments: z.number().int(),
  teams: z.number().int(),
  locations: z.number().int(),
  costCenters: z.number().int(),
});

const teamNodeSchema = teamItemSchema.extend({
  type: z.literal("team"),
  children: z.array(z.never()),
});

const departmentNodeSchema = departmentItemSchema.extend({
  type: z.literal("department"),
  children: z.array(teamNodeSchema),
});

const branchNodeSchema = branchItemSchema.extend({
  description: z.string().nullable(),
  type: z.literal("branch"),
  children: z.array(departmentNodeSchema),
});

const businessUnitNodeSchema = businessUnitItemSchema.omit({ parentId: true }).extend({
  type: z.literal("business_unit"),
  children: z.array(branchNodeSchema),
});

/**
 * `OrgHierarchyReadService.getTree` — business_unit > branch > department > team.
 * A node orphaned from its parent is returned at the root, so every level is a
 * root candidate and the array is a union of all four rather than of one.
 */
export const hierarchyTreeResponseSchema = z.array(
  z.discriminatedUnion("type", [
    businessUnitNodeSchema,
    branchNodeSchema,
    departmentNodeSchema,
    teamNodeSchema,
  ]),
);

// ─── Dependency Preview ────────────────────────────────────────────────────

/** `OrgHierarchyService.getDependencyPreview` */
export const dependencyPreviewResponseSchema = z.object({
  unitId: z.string(),
  unitKind: z.string(),
  mode: z.string(),
  dependencies: z.array(z.object({
    key: z.string(),
    label: z.string(),
    count: z.number().int(),
  })),
  totalDependencies: z.number().int(),
});
