import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PayrollEntitiesService } from "./entities.service";

const createEntitySchema = z.object({
  legalName: z.string().min(1).max(200),
  countryCode: z.string().length(2).optional(),
  stateCode: z.string().max(10).optional(),
  baseCurrency: z.string().length(3).optional(),
  pan: z.string().max(20).optional(),
  tan: z.string().max(20).optional(),
  pfEstablishmentCode: z.string().max(50).optional(),
  esiCode: z.string().max(50).optional(),
  ptStateCode: z.string().max(10).optional(),
});

@Controller("payroll/entities")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollEntitiesController {
  constructor(private readonly service: PayrollEntitiesService) {}

  @Get()
  @RequirePermission("payroll:policies:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("payroll:policies:manage")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createEntitySchema)) body: z.infer<typeof createEntitySchema>,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }
}
