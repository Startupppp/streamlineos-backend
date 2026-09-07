import { Controller, Get, Patch, Param, ParseIntPipe, Query, Body, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvTraceabilityService } from "./inv-traceability.service";
import { TraceabilityChainService } from "./traceability-chain.service";
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listLotsResponseSchema,
  getLotDetailResponseSchema,
  updateLotStatusResponseSchema,
  listSerialsResponseSchema,
  getSerialDetailResponseSchema,
  expiryReportResponseSchema,
  traceabilityChainResponseSchema,
} from "./dto/traceability-response.schemas";
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
  ) {}

  @Get("lots")
  @ResponseSchema(listLotsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listLotsSchema })
  async listLots(
    @Query() filters: ListLotsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.listLots(u.orgId, filters);
  }

  @Get("lots/:lotId")
  @ResponseSchema(getLotDetailResponseSchema)
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
  @ResponseSchema(updateLotStatusResponseSchema)
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
  @ResponseSchema(listSerialsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: listSerialsSchema })
  async listSerials(
    @Query() filters: ListSerialsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.traceability.listSerials(u.orgId, filters);
  }

  @Get("serials/:serialId")
  @ResponseSchema(getSerialDetailResponseSchema)
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
  @ResponseSchema(expiryReportResponseSchema)
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
  @ResponseSchema(traceabilityChainResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ query: traceabilityQuerySchema })
  async getTraceabilityChain(
    @Query() query: TraceabilityQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.chain.getChain(u.orgId, query);
  }
}
