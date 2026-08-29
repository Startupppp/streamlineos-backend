import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { InspectionPlansService } from "./inspection-plans.service";
import {
  createInspectionPlanSchema,
  createPlanVersionSchema,
  listInspectionPlansQuerySchema,
  updateInspectionPlanSchema,
} from "./dto/inspection-plans.schemas";
import type {
  CreateInspectionPlanInput,
  CreatePlanVersionInput,
  ListInspectionPlansQueryInput,
  UpdateInspectionPlanInput,
} from "./dto/inspection-plans.schemas";

@RequireModule("inventory")
@Controller("inventory/quality/inspection-plans")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InspectionPlansController {
  constructor(private readonly svc: InspectionPlansService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  list(
    @Query(new ZodValidationPipe(listInspectionPlansQuerySchema)) q: ListInspectionPlansQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get(":planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  findOne(
    @Param("planId", ParseIntPipe) planId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, planId);
  }

  @Get(":planId/versions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  listVersions(
    @Param("planId", ParseIntPipe) planId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listVersions(u.orgId, planId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:plans:manage")
  create(
    @Body(new ZodValidationPipe(createInspectionPlanSchema)) body: CreateInspectionPlanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:plans:manage")
  update(
    @Param("planId", ParseIntPipe) planId: number,
    @Body(new ZodValidationPipe(updateInspectionPlanSchema)) body: UpdateInspectionPlanInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, planId, body);
  }

  @Delete(":planId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:plans:manage")
  remove(
    @Param("planId", ParseIntPipe) planId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.remove(u.orgId, u.userId, planId);
  }

  @Post(":planId/versions")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:plans:manage")
  addVersion(
    @Param("planId", ParseIntPipe) planId: number,
    @Body(new ZodValidationPipe(createPlanVersionSchema)) body: CreatePlanVersionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addVersion(u.orgId, u.userId, planId, body);
  }

  @Post(":planId/versions/:versionId/activate")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:plans:manage")
  activateVersion(
    @Param("planId", ParseIntPipe) planId: number,
    @Param("versionId", ParseIntPipe) versionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.activateVersion(u.orgId, u.userId, planId, versionId);
  }
}
