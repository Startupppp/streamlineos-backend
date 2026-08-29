import { Controller, Get, Patch, Param, ParseIntPipe, Query, Body, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvTraceabilityService } from "./inv-traceability.service";
import { TraceabilityChainService } from "./traceability-chain.service";
import { LotGenealogyService } from "./lot-genealogy.service";
import { genealogyToCsv } from "./lib/genealogy-csv";
import { genealogyQuerySchema, type GenealogyQueryInput } from "./dto/genealogy.schemas";
import {
  listLotsSchema,
  listSerialsSchema,
  expiryQuerySchema,
  updateLotStatusSchema,
  traceabilityQuerySchema,
  type ListLotsInput,
  type ListSerialsInput,
  type ExpiryQueryInput,
  type UpdateLotStatusInput,
  type TraceabilityQueryInput,
} from "./dto/traceability.schemas";

@RequireModule("inventory")
@Controller("inventory")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvTraceabilityController {
  constructor(
    private readonly traceability: InvTraceabilityService,
    private readonly chain: TraceabilityChainService,
    private readonly genealogy: LotGenealogyService,
  ) {}

  @Get("lots")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async listLots(
    @Query(new ZodValidationPipe(listLotsSchema)) filters: ListLotsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.listLots(u.orgId, u.userId, filters);
  }

  @Get("lots/:lotId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async getLotDetail(
    @Param("lotId", ParseIntPipe) lotId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.getLotDetail(u.orgId, lotId);
  }

  @Patch("lots/:lotId/status")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  async updateLotStatus(
    @Param("lotId", ParseIntPipe) lotId: number,
    @Body(new ZodValidationPipe(updateLotStatusSchema)) body: UpdateLotStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.updateLotStatus(u.orgId, lotId, body);
  }

  @Get("serials")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async listSerials(
    @Query(new ZodValidationPipe(listSerialsSchema)) filters: ListSerialsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.listSerials(u.orgId, u.userId, filters);
  }

  @Get("serials/:serialId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async getSerialDetail(
    @Param("serialId", ParseIntPipe) serialId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.getSerialDetail(u.orgId, serialId);
  }

  @Get("expiry")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async getExpiryList(
    @Query(new ZodValidationPipe(expiryQuerySchema)) query: ExpiryQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.getExpiryReport(u.orgId, query.withinDays);
  }

  @Get("traceability")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async getTraceabilityChain(
    @Query(new ZodValidationPipe(traceabilityQuerySchema)) query: TraceabilityQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.chain.getChain(u.orgId, query);
  }

  /**
   * D1. The bounded genealogy graph around one lot or serial. Every answer
   * carries the caps it was walked under and says whether they cut it short.
   */
  @Get("traceability/genealogy")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async getGenealogy(
    @Query(new ZodValidationPipe(genealogyQuerySchema)) query: GenealogyQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.genealogy.getGraph(u.orgId, u.userId, query);
  }

  @Get("traceability/genealogy/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:export")
  async exportGenealogy(
    @Query(new ZodValidationPipe(genealogyQuerySchema)) query: GenealogyQueryInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const graph = await this.genealogy.getGraph(u.orgId, u.userId, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="genealogy-${graph.anchor.kind}-${String(graph.anchor.id)}.csv"`,
    );
    res.setHeader("X-Genealogy-Complete", String(graph.truncation.complete));
    res.setHeader("X-Genealogy-Truncation-Reasons", graph.truncation.reasons.join(","));
    res.send(genealogyToCsv(graph));
  }
}
