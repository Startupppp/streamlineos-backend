import {
  BadRequestException,
  Body,
  Controller,
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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BonusesService } from "./bonuses.service";
import {
  createBonusSchema,
  patchBonusSchema,
  type CreateBonusInput,
  type PatchBonusInput,
} from "./dto/payroll.schemas";

@Controller("hr/bonuses")
@UseGuards(JwtAuthGuard)
export class BonusesController {
  constructor(private readonly bonuses: BonusesService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    const isAdmin = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("hr:payroll:approve");
    return this.bonuses.listBonuses(u.orgId, u.userId, isAdmin);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:bonuses:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createBonusSchema)) body: CreateBonusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bonuses.createBonus(u.orgId, body);
  }

  @Patch(":bonusId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:bonuses:manage")
  async update(
    @Param("bonusId", ParseIntPipe) bonusId: number,
    @Body(new ZodValidationPipe(patchBonusSchema)) body: PatchBonusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.bonuses.updateBonus(u.orgId, u.userId, bonusId, body);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Bonus not found.");
      if (result.reason === "already_paid") throw new BadRequestException("Bonus has already been paid.");
      throw new BadRequestException("Cannot mark a rejected bonus as paid.");
    }
    return result.bonus;
  }
}
