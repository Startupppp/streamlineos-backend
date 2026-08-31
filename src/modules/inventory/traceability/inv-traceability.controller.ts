import { Controller, Get, Patch, Param, ParseIntPipe, Query, Body, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { InvTraceabilityService } from "./inv-traceability.service";
import { TraceabilityChainService } from "./traceability-chain.service";
import { LotGenealogyService } from "./lot-genealogy.service";
import { AllocationOverrideReportService } from "./allocation-override-report.service";
import { genealogyToCsv } from "./lib/genealogy-csv";
import { genealogyQuerySchema, type GenealogyQueryInput } from "./dto/genealogy.schemas";
import {
  listAllocationOverridesSchema,
  type ListAllocationOverridesInput,
} from "./dto/allocation-overrides.schemas";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const lotIdParams = z.object({ lotId: z.coerce.number().int().positive() }).strict();
const serialIdParams = z.object({ serialId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvTraceabilityController {
  constructor(
    private readonly traceability: InvTraceabilityService,
    private readonly chain: TraceabilityChainService,
    private readonly genealogy: LotGenealogyService,
    private readonly allocationOverrides: AllocationOverrideReportService,
  ) {}

  @Get("lots")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listLotsSchema })
  async listLots(
    @Query() filters: ListLotsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.listLots(u.orgId, u.userId, filters);
  }

  @Get("lots/:lotId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: lotIdParams })
  async getLotDetail(
    @Param("lotId", ParseIntPipe) lotId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.getLotDetail(u.orgId, lotId);
  }

  @Patch("lots/:lotId/status")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @Validate({ params: lotIdParams, body: updateLotStatusSchema })
  async updateLotStatus(
    @Param("lotId", ParseIntPipe) lotId: number,
    @Body() body: UpdateLotStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.updateLotStatus(u.orgId, lotId, body);
  }

  @Get("serials")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listSerialsSchema })
  async listSerials(
    @Query() filters: ListSerialsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.listSerials(u.orgId, u.userId, filters);
  }

  @Get("serials/:serialId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: serialIdParams })
  async getSerialDetail(
    @Param("serialId", ParseIntPipe) serialId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.getSerialDetail(u.orgId, serialId);
  }

  @Get("expiry")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: expiryQuerySchema })
  async getExpiryList(
    @Query() query: ExpiryQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.getExpiryReport(u.orgId, query.withinDays);
  }

  @Get("traceability")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: traceabilityQuerySchema })
  async getTraceabilityChain(
    @Query() query: TraceabilityQueryInput,
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

  /**
   * D2. Every allocation somebody took past the allocator's refusal — who, why,
   * which rule, how short-dated the lot was, and which customer received it.
   *
   * Here rather than under `audit-events` because it is asked as a trace: the
   * entry points are a lot number off a recall notice and a customer off a
   * complaint, both of which are the anchors the rest of this controller takes.
   * Gated on the audit key all the same — it is the trail, not stock data.
   */
  @Get("traceability/allocation-overrides")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:read")
  async listAllocationOverrides(
    @Query(new ZodValidationPipe(listAllocationOverridesSchema)) query: ListAllocationOverridesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.allocationOverrides.list(u.orgId, query);
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
