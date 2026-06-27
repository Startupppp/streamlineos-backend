import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReimbursementsService } from "./reimbursements.service";
import {
  createReimbursementSchema,
  patchReimbursementSchema,
  type CreateReimbursementInput,
  type PatchReimbursementInput,
} from "./dto/payroll.schemas";

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

  @Patch(":reimbursementId")
  async update(
    @Param("reimbursementId", ParseIntPipe) reimbursementId: number,
    @Body(new ZodValidationPipe(patchReimbursementSchema)) body: PatchReimbursementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const ability = defineAbilityFor({
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
    });
    if (!ability.can("approve", "hr:expenses")) {
      throw new ForbiddenException("Only admins can process reimbursements.");
    }

    const result = await this.reimbursements.updateStatus(u.orgId, u.userId, reimbursementId, body);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Not found.");
      throw new ForbiddenException("You cannot approve or reject your own reimbursement.");
    }
    return { success: true };
  }
}
