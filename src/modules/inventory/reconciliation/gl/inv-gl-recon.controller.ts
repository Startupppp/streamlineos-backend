import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { InvGlReconService } from "./inv-gl-recon.service";
import { glReconQuerySchema, type GlReconQueryInput } from "./dto/gl-recon.schemas";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  glReconReportResponseSchema,
  listGlReconPeriodsResponseSchema,
} from "./dto/gl-recon-response.schemas";

/**
 * Read-only. There is no mutating route here on purpose: the fix for a
 * `MISSING_COA` row is a chart-of-accounts entry in the accounting module, and
 * the fix for an `UNMATCHED` row is re-running the document that should have
 * posted. Neither belongs to a report.
 *
 * Gated on `inventory:reports:read` — the same key as every other cross-document
 * inventory report. The figures are costs, so `inventory:valuation:read` gates
 * the summary the operator drills in from; both keys already exist and neither
 * is added here.
 */
@RequireModule("inventory")
@Controller("inventory/reconciliation/gl")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvGlReconController {
  constructor(private readonly recon: InvGlReconService) {}

  @Get()
  @ResponseSchema(glReconReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  report(
    @Query(new ZodValidationPipe(glReconQuerySchema)) query: GlReconQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recon.report(u.orgId, u.userId, query);
  }

  @Get("periods")
  @ResponseSchema(listGlReconPeriodsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  listPeriods(@CurrentUser() u: CurrentUserContext) {
    return this.recon.listPeriods(u.orgId);
  }
}
