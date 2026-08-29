import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { InspectionsService } from "./quality-inspections.service";
import {
  listInspectionsQuerySchema,
  createInspectionSchema,
  failInspectionSchema,
  disposeInspectionSchema,
} from "./dto/quality.schemas";
import { correctInspectionSchema } from "./dto/inspection-plans.schemas";
import type { CorrectInspectionInput } from "./dto/inspection-plans.schemas";
import type {
  ListInspectionsQueryInput,
  CreateInspectionInput,
  FailInspectionInput,
  DisposeInspectionInput,
} from "./dto/quality.schemas";

@RequireModule("inventory")
@Controller("inventory/quality/inspections")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InspectionsController {
  constructor(private readonly svc: InspectionsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  list(
    @Query(new ZodValidationPipe(listInspectionsQuerySchema)) q: ListInspectionsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get(":inspectionId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  findOne(
    @Param("inspectionId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, id);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  create(
    @Body(new ZodValidationPipe(createInspectionSchema)) body: CreateInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Post(":inspectionId/start")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  start(
    @Param("inspectionId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.start(u.orgId, u.userId, id);
  }

  @Post(":inspectionId/pass")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  pass(
    @Param("inspectionId", ParseIntPipe) id: number,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.svc.pass(u.orgId, u.userId, id, idempotencyKey);
  }

  @Post(":inspectionId/fail")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  fail(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(failInspectionSchema)) body: FailInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.fail(u.orgId, u.userId, id, body);
  }

  @Post(":inspectionId/dispose")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  dispose(
    @Param("inspectionId", ParseIntPipe) id: number,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(disposeInspectionSchema)) body: DisposeInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.svc.dispose(u.orgId, u.userId, id, body, idempotencyKey);
  }

  /**
   * Cancelling gives back whatever the inspection was holding, so it moves
   * stock and takes a key like every other command that does.
   */
  @Post(":inspectionId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  cancel(
    @Param("inspectionId", ParseIntPipe) id: number,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancel(u.orgId, u.userId, id, idempotencyKey);
  }

  /**
   * A completed result is evidence and is never edited; correcting one raises a
   * fresh inspection that names what it supersedes.
   */
  @Post(":inspectionId/correct")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  correct(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(correctInspectionSchema)) body: CorrectInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.correct(u.orgId, u.userId, id, body);
  }
}
