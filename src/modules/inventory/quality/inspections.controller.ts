import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const inspectionIdParams = z.object({ inspectionId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/quality/inspections")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InspectionsController {
  constructor(private readonly svc: InspectionsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ query: listInspectionsQuerySchema })
  list(
    @Query() q: ListInspectionsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get(":inspectionId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ params: inspectionIdParams })
  findOne(
    @Param("inspectionId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, id);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ body: createInspectionSchema })
  create(
    @Body() body: CreateInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Post(":inspectionId/start")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ params: inspectionIdParams })
  start(
    @Param("inspectionId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.start(u.orgId, u.userId, id);
  }

  @Post(":inspectionId/pass")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  @Validate({ params: inspectionIdParams })
  pass(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.svc.pass(u.orgId, u.userId, id, idempotencyKey);
  }

  @Post(":inspectionId/fail")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ params: inspectionIdParams, body: failInspectionSchema })
  fail(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Body() body: FailInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.fail(u.orgId, u.userId, id, body);
  }

  @Post(":inspectionId/dispose")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ params: inspectionIdParams, body: disposeInspectionSchema })
  dispose(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: DisposeInspectionInput,
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
  @Validate({ params: inspectionIdParams })
  cancel(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
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
  @Validate({ params: inspectionIdParams, body: correctInspectionSchema })
  correct(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Body() body: CorrectInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.correct(u.orgId, u.userId, id, body);
  }
}
