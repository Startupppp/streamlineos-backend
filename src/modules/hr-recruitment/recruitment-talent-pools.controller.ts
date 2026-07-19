import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentTalentPoolsService } from "./recruitment-talent-pools.service";
import {
  addPoolMemberSchema,
  createTalentPoolSchema,
  updateTalentPoolSchema,
  type AddPoolMemberInput,
  type CreateTalentPoolInput,
  type UpdateTalentPoolInput,
} from "./dto/talent-pools.schemas";

@RequireModule("hr")
@Controller("hr/recruitment/talent-pools")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentTalentPoolsController {
  constructor(private readonly pools: RecruitmentTalentPoolsService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.pools.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  create(
    @Body(new ZodValidationPipe(createTalentPoolSchema)) body: CreateTalentPoolInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.create(u.orgId, u.userId, body);
  }

  @Patch(":poolId")
  @RequirePermission("hr:employees:manage")
  update(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Body(new ZodValidationPipe(updateTalentPoolSchema)) body: UpdateTalentPoolInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.update(u.orgId, poolId, body);
  }

  @Delete(":poolId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  remove(@Param("poolId", ParseIntPipe) poolId: number, @CurrentUser() u: CurrentUserContext) {
    return this.pools.remove(u.orgId, poolId);
  }

  @Get(":poolId/members")
  @RequirePermission("hr:employees:view")
  listMembers(@Param("poolId", ParseIntPipe) poolId: number, @CurrentUser() u: CurrentUserContext) {
    return this.pools.listMembers(u.orgId, poolId);
  }

  @Post(":poolId/members")
  @HttpCode(201)
  @RequirePermission("hr:employees:manage")
  addMember(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Body(new ZodValidationPipe(addPoolMemberSchema)) body: AddPoolMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.addMember(u.orgId, u.userId, poolId, body);
  }

  @Delete(":poolId/members/:candidateId")
  @HttpCode(204)
  @RequirePermission("hr:employees:manage")
  async removeMember(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.pools.removeMember(u.orgId, poolId, candidateId);
  }
}
