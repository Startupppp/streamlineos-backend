import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrGrowthService } from "./hr-growth.service";
import { createCareerLadderSchema, type CreateCareerLadderInput } from "./dto/growth.schemas";

@Controller("hr/career-ladders")
@UseGuards(JwtAuthGuard)
export class HrCareerLaddersController {
  constructor(private readonly growth: HrGrowthService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.growth.listCareerLadders(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:career-ladders:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createCareerLadderSchema)) body: CreateCareerLadderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.growth.createCareerLadder(u.orgId, body);
  }
}
