import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RisksService } from "./risks.service";
import { orgListRisksQuerySchema, type OrgListRisksQuery } from "./dto/org-governance.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { riskPageSchema } from "./dto/governance-response.schemas";

@RequireModule("build")
@Controller("build/risks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrgRisksController {
  constructor(private readonly svc: RisksService) {}

  @Get()
  @RequirePermission("build:risks:view")
  @ResponseSchema(riskPageSchema)
  @Validate({ query: orgListRisksQuerySchema })
  listOrgRisks(@CurrentUser() u: CurrentUserContext, @Query() query: OrgListRisksQuery) {
    return this.svc.listOrgRisks(u, query);
  }
}
