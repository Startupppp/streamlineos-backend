import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RecallsService } from "./quality-recalls.service";
import { listRecallsQuerySchema, createRecallSchema, updateRecallSchema } from "./dto/quality.schemas";
import type { ListRecallsQueryInput, CreateRecallInput, UpdateRecallInput } from "./dto/quality.schemas";

@RequireModule("inventory")
@Controller("inventory/quality/recalls")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class RecallsController {
  constructor(private readonly svc: RecallsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  list(
    @Query(new ZodValidationPipe(listRecallsQuerySchema)) q: ListRecallsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get(":recallId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  findOne(
    @Param("recallId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, id);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:recall")
  create(
    @Body(new ZodValidationPipe(createRecallSchema)) body: CreateRecallInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":recallId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:recall")
  update(
    @Param("recallId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateRecallSchema)) body: UpdateRecallInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }
}
