import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CrmCustomer360Service } from "./crm-customer360.service";
import { Validate } from "../../../common/validation/validate.decorator";

const companyIdParams = z.object({ companyId: z.coerce.number().int().positive() }).strict();
const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();

const timelineQuerySchema = z.object({
  cursor: z.string().optional(),
});
type TimelineQuery = z.infer<typeof timelineQuerySchema>;

@RequireModule("crm")
@Controller("crm/customer-360")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmCustomer360Controller {
  constructor(private readonly svc: CrmCustomer360Service) {}

  @Get("company/:companyId")
  @RequirePermission("crm:customer360:view")
  @Validate({ params: companyIdParams })
  async getCompany360(
    @Param("companyId", ParseIntPipe) companyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.svc.getCompany360(u.orgId, companyId, u.userId);
    if (!result || Object.keys(result).length === 0) throw new NotFoundException("Company not found");
    return result;
  }

  @Get("client/:clientId")
  @RequirePermission("crm:customer360:view")
  @Validate({ params: clientIdParams })
  async getClient360(
    @Param("clientId", ParseIntPipe) clientId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.svc.getClient360(u.orgId, clientId, u.userId);
    if (!result || Object.keys(result).length === 0) throw new NotFoundException("Client not found");
    return result;
  }

  @Get("company/:companyId/timeline")
  @RequirePermission("crm:customer360:view")
  @Validate({ params: companyIdParams })
  async getCompanyTimeline(
    @Param("companyId", ParseIntPipe) companyId: number,
    @Query(new ZodValidationPipe(timelineQuerySchema)) query: TimelineQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getCompanyTimeline(u.orgId, companyId, query.cursor);
  }
}
