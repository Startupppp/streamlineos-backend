import { BadRequestException, Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
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
import type {
  ListInspectionsQueryInput,
  CreateInspectionInput,
  FailInspectionInput,
  DisposeInspectionInput,
} from "./dto/quality.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listInspectionsResponseSchema,
  createInspectionResponseSchema,
} from "./dto/quality-response.schemas";

const inspectionIdParams = z.object({ inspectionId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/quality/inspections")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InspectionsController {
  constructor(private readonly svc: InspectionsService) {}

  @Get()
  @ResponseSchema(listInspectionsResponseSchema)
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
  @ResponseSchema(createInspectionResponseSchema)
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
  @ResponseSchema(createInspectionResponseSchema)
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
  @BodylessAction()
  @ResponseSchema(createInspectionResponseSchema)
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
  @BodylessAction()
  @ResponseSchema(createInspectionResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:release")
  @Validate({ params: inspectionIdParams })
  pass(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.svc.pass(u.orgId, u.userId, id, idempotencyKey);
  }

  @Post(":inspectionId/fail")
  @ResponseSchema(createInspectionResponseSchema)
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
  @ResponseSchema(createInspectionResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ params: inspectionIdParams, body: disposeInspectionSchema })
  dispose(
    @Param("inspectionId", ParseIntPipe) id: number,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: DisposeInspectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.svc.dispose(u.orgId, u.userId, id, body, idempotencyKey);
  }

  @Post(":inspectionId/cancel")
  @BodylessAction()
  @ResponseSchema(createInspectionResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:inspect")
  @Validate({ params: inspectionIdParams })
  cancel(
    @Param("inspectionId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancel(u.orgId, u.userId, id);
  }
}
