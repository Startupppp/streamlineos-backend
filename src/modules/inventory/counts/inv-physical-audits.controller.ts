import { BadRequestException, Controller, Get, Headers, Param, ParseIntPipe, Patch, Post, Body, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvPhysicalAuditsService } from "./inv-physical-audits.service";
import {
  listCountsSchema, createAuditSchema, updateCountLinesSchema,
  type ListCountsInput, type CreateAuditInput, type UpdateCountLinesInput,
} from "./dto/inv-counts.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const auditIdParams = z.object({ auditId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/physical-audits")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvPhysicalAuditsController {
  constructor(private readonly audits: InvPhysicalAuditsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listCountsSchema })
  list(
    @Query() filters: ListCountsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.listAudits(u.orgId, filters);
  }

  @Get(":auditId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: auditIdParams })
  getOne(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.getAudit(u.orgId, auditId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ body: createAuditSchema })
  create(
    @Body() body: CreateAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.createAudit(u.orgId, u.userId, body);
  }

  @Post(":auditId/start")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams })
  start(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.startAudit(u.orgId, auditId);
  }

  @Patch(":auditId/lines")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams, body: updateCountLinesSchema })
  updateLines(
    @Param("auditId", ParseIntPipe) auditId: number,
    @Body() body: UpdateCountLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.updateLines(u.orgId, auditId, body);
  }

  @Post(":auditId/review")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams })
  review(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.reviewAudit(u.orgId, auditId);
  }

  @Post(":auditId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams })
  post(
    @Headers("idempotency-key") idempotencyKey: string,
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.audits.postAudit(u.orgId, u.userId, auditId, idempotencyKey);
  }

  @Post(":auditId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams })
  cancel(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.cancelAudit(u.orgId, auditId);
  }
}
