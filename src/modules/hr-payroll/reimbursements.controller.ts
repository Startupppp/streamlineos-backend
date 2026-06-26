import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReimbursementsService } from "./reimbursements.service";
import { createReimbursementSchema, type CreateReimbursementInput } from "./dto/payroll.schemas";

@Controller("hr/reimbursements")
@UseGuards(JwtAuthGuard)
export class ReimbursementsController {
  constructor(private readonly reimbursements: ReimbursementsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    const ability = defineAbilityFor({
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
    });
    const isAdmin = ability.can("approve", "hr:expenses");
    return this.reimbursements.listReimbursements(u.orgId, u.userId, isAdmin);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createReimbursementSchema)) body: CreateReimbursementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.createReimbursement(u.orgId, u.userId, body);
  }
}
