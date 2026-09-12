import { Controller, Get, Param, ParseIntPipe, Patch, Post, Body, Query, UseGuards } from "@nestjs/common";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
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
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  listAuditsResponseSchema,
  physicalAuditSchema,
} from "./dto/counts-response.schemas";

const auditIdParams = z.object({ auditId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/physical-audits")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvPhysicalAuditsController {
  constructor(private readonly audits: InvPhysicalAuditsService) {}

  @Get()
  @ResponseSchema(listAuditsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listCountsSchema })
  list(
    @Query() filters: ListCountsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.listAudits(u.orgId, u.userId, filters);
  }

  @Get(":auditId")
  @ResponseSchema(physicalAuditSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: auditIdParams })
  getOne(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.getAudit(u.orgId, u.userId, auditId);
  }

  @Post()
  @ResponseSchema(physicalAuditSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.physical-audit.create")
  @Validate({ body: createAuditSchema })
  create(
    @Body() body: CreateAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.createAudit(u.orgId, u.userId, body);
  }

  @Post(":auditId/start")
  @BodylessAction()
  @ResponseSchema(physicalAuditSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.physical-audit.start")
  @Validate({ params: auditIdParams })
  start(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.startAudit(u.orgId, u.userId, auditId);
  }

  @Patch(":auditId/lines")
  @ResponseSchema(physicalAuditSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams, body: updateCountLinesSchema })
  updateLines(
    @Param("auditId", ParseIntPipe) auditId: number,
    @Body() body: UpdateCountLinesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.updateLines(u.orgId, u.userId, auditId, body);
  }

  @Post(":auditId/review")
  @BodylessAction()
  @ResponseSchema(physicalAuditSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.physical-audit.review")
  @Validate({ params: auditIdParams })
  review(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audits.reviewAudit(u.orgId, u.userId, auditId);
  }

  @Post(":auditId/post")
  @BodylessAction()
  @ResponseSchema(physicalAuditSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Validate({ params: auditIdParams })
  post(
    @IdempotencyKey() idempotencyKey: string,
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.audits.postAudit(u.orgId, u.userId, auditId, idempotencyKey);
  }

  @Post(":auditId/cancel")
  @BodylessAction()
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @Idempotent("inventory.physical-audit.cancel")
  @Validate({ params: auditIdParams })
  async cancel(
    @Param("auditId", ParseIntPipe) auditId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.audits.cancelAudit(u.orgId, u.userId, auditId);
    return { success: true as const };
  }
}
