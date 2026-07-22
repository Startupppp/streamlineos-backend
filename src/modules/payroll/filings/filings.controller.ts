import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollFilingsService } from "./filings.service";

const prepareSchema = z.object({
  filingType: z.enum(["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"]),
  periodId: z.number().int().positive().optional(),
  entityId: z.number().int().positive().optional(),
  fiscalYear: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  ruleVersion: z.string().optional(),
});

const ackSchema = z.object({
  challanRef: z.string().max(120).optional(),
  acknowledgementRef: z.string().max(120).optional(),
});

@Controller("payroll/filings")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollFilingsController {
  constructor(private readonly service: PayrollFilingsService) {}

  @Get()
  @RequirePermission("payroll:tax:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post("export")
  @HttpCode(201)
  @RequirePermission("payroll:tax:manage")
  prepare(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(prepareSchema)) body: z.infer<typeof prepareSchema>,
  ) {
    return this.service.prepareExport(u.orgId, u.userId, body);
  }

  @Patch(":filingId/acknowledgement")
  @RequirePermission("payroll:tax:manage")
  ack(
    @CurrentUser() u: CurrentUserContext,
    @Param("filingId", ParseIntPipe) filingId: number,
    @Body(new ZodValidationPipe(ackSchema)) body: z.infer<typeof ackSchema>,
  ) {
    return this.service.attachAcknowledgement(u.orgId, filingId, body);
  }
}
