import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrOrgCatalogService } from "./hr-org-catalog.service";
import { z } from "zod";

const catalogNameSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name must be at most 100 characters")
      .refine((v) => /[a-zA-Z]/.test(v), "Name must contain at least one letter")
      .refine(
        (v) => !/[^\p{L}\p{N}\s]{2,}/u.test(v),
        "Name cannot have consecutive special characters",
      ),
  );

const catalogCodeSchema = z
  .union([
    z.literal("").transform(() => undefined),
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(
        z
          .string()
          .min(1, "Code must be at least 1 character")
          .max(20, "Code must be at most 20 characters")
          .regex(
            /^[A-Z0-9][A-Z0-9_-]*$/,
            "Code can only use letters, numbers, hyphens, and underscores",
          ),
      ),
  ])
  .optional();

const createCatalogSchema = z.object({
  name: catalogNameSchema,
  code: catalogCodeSchema,
  description: z.string().trim().max(500).optional(),
});

const updateCatalogSchema = createCatalogSchema.partial();

const createLocationSchema = createCatalogSchema.extend({
  type: z.string().optional(),
  address: z
    .object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      postalCode: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
});

const updateLocationSchema = createLocationSchema.partial();

type CreateCatalogInput = z.infer<typeof createCatalogSchema>;
type UpdateCatalogInput = z.infer<typeof updateCatalogSchema>;
type CreateLocationInput = z.infer<typeof createLocationSchema>;
type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

@RequireModule("hr")
@Controller("hr/org")
@UseGuards(JwtAuthGuard)
export class HrOrgCatalogController {
  constructor(private readonly catalog: HrOrgCatalogService) {}

  @Get("locations")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  listLocations(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listLocations(u.orgId);
  }

  @Post("locations")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  createLocation(
    @Body(new ZodValidationPipe(createLocationSchema)) body: CreateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createLocation(u.orgId, body);
  }

  @Patch("locations/:locationId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  updateLocation(
    @Param("locationId") locationId: string,
    @Body(new ZodValidationPipe(updateLocationSchema)) body: UpdateLocationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateLocation(u.orgId, locationId, body);
  }

  @Delete("locations/:locationId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  deleteLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.deleteLocation(u.orgId, locationId);
  }

  @Get("roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  listJobRoles(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listJobRoles(u.orgId);
  }

  @Post("roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  createJobRole(
    @Body(new ZodValidationPipe(createCatalogSchema)) body: CreateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createJobRole(u.orgId, body);
  }

  @Patch("roles/:roleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  updateJobRole(
    @Param("roleId", ParseIntPipe) roleId: number,
    @Body(new ZodValidationPipe(updateCatalogSchema)) body: UpdateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateJobRole(u.orgId, roleId, body);
  }

  @Delete("roles/:roleId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  deleteJobRole(
    @Param("roleId", ParseIntPipe) roleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.deleteJobRole(u.orgId, roleId);
  }

  @Get("levels")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  listJobLevels(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listJobLevels(u.orgId);
  }

  @Post("levels")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  createJobLevel(
    @Body(new ZodValidationPipe(createCatalogSchema)) body: CreateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createJobLevel(u.orgId, body);
  }

  @Patch("levels/:levelId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  updateJobLevel(
    @Param("levelId", ParseIntPipe) levelId: number,
    @Body(new ZodValidationPipe(updateCatalogSchema)) body: UpdateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateJobLevel(u.orgId, levelId, body);
  }

  @Delete("levels/:levelId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  deleteJobLevel(
    @Param("levelId", ParseIntPipe) levelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.deleteJobLevel(u.orgId, levelId);
  }

  @Get("teams")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  listTeams(@CurrentUser() u: CurrentUserContext) {
    return this.catalog.listTeams(u.orgId);
  }

  @Post("teams")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  createTeam(
    @Body(new ZodValidationPipe(createCatalogSchema)) body: CreateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.createTeam(u.orgId, body);
  }

  @Patch("teams/:teamId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  updateTeam(
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(updateCatalogSchema)) body: UpdateCatalogInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.updateTeam(u.orgId, teamId, body);
  }

  @Delete("teams/:teamId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  deleteTeam(
    @Param("teamId") teamId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.deleteTeam(u.orgId, teamId);
  }

  @Get("headcount")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  getHeadcount(
    @Query("groupBy") groupBy: string = "department",
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.catalog.getHeadcount(u.orgId, groupBy);
  }
}
