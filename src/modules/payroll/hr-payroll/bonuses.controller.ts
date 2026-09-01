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
  Query,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { BonusesService } from "./bonuses.service";
import {
  createBonusSchema,
  patchBonusSchema,
  type CreateBonusInput,
  type PatchBonusInput,
  cursorListQuerySchema,
  type CursorListQueryInput,
} from "./dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const bonusIdParams = z.object({ bonusId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("hr/bonuses")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class BonusesController {
  constructor(
    private readonly bonuses: BonusesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:payroll:view")
  @Validate({ query: cursorListQuerySchema })
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: CursorListQueryInput,
  ) {
    let isAdmin = u.isOrgOwner;
    if (!isAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      isAdmin = perms.has("hr:payroll:approve");
    }
    return this.bonuses.listBonuses(
      u.orgId,
      actingMembershipId(u.principal),
      isAdmin,
      query.cursor,
      query.limit ?? 100,
    );
  }

  @Post()
  @RequirePermission("hr:bonuses:manage")
  @HttpCode(201)
  @Validate({ body: createBonusSchema })
  create(
    @Body() body: CreateBonusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bonuses.createBonus(u.orgId, body);
  }

  @Patch(":bonusId")
  @RequirePermission("hr:bonuses:manage")
  @Validate({ params: bonusIdParams, body: patchBonusSchema })
  async update(
    @Param("bonusId", ParseIntPipe) bonusId: number,
    @Body() body: PatchBonusInput,
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
