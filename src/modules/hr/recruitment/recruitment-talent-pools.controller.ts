import { Controller, Get, HttpCode, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecruitmentTalentPoolsService } from "./recruitment-talent-pools.service";
import {
  addPoolMemberSchema,
  createTalentPoolSchema,
  listPoolMembersQuerySchema,
  updateTalentPoolSchema,
  type AddPoolMemberInput,
  type CreateTalentPoolInput,
  type ListPoolMembersQueryInput,
  type UpdateTalentPoolInput,
} from "./dto/talent-pools.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  talentPoolSchema,
  talentPoolMembersResponseSchema,
  talentPoolMemberRowSchema,
} from "./dto/recruitment-response.schemas";

const poolIdParams = z.object({ poolId: z.coerce.number().int().positive() }).strict();
const poolIdcandidateIdParams = z.object({ poolId: z.coerce.number().int().positive(), candidateId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment/talent-pools")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentTalentPoolsController {
  constructor(private readonly pools: RecruitmentTalentPoolsService) {}

  @Get()
  @ResponseSchema(z.array(talentPoolSchema))
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.pools.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(talentPoolSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ body: createTalentPoolSchema })
  create(
    @Body() body: CreateTalentPoolInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.create(u.orgId, u.userId, body);
  }

  @Patch(":poolId")
  @ResponseSchema(talentPoolSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: poolIdParams, body: updateTalentPoolSchema })
  update(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Body() body: UpdateTalentPoolInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.update(u.orgId, poolId, body);
  }

  @Delete(":poolId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: poolIdParams })
  remove(@Param("poolId", ParseIntPipe) poolId: number, @CurrentUser() u: CurrentUserContext) {
    return this.pools.remove(u.orgId, poolId);
  }

  @Get(":poolId/members")
  @ResponseSchema(talentPoolMembersResponseSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: poolIdParams, query: listPoolMembersQuerySchema })
  listMembers(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Query() query: ListPoolMembersQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.listMembers(u.orgId, poolId, query);
  }

  @Post(":poolId/members")
  @HttpCode(201)
  @ResponseSchema(talentPoolMemberRowSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: poolIdParams, body: addPoolMemberSchema })
  addMember(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Body() body: AddPoolMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pools.addMember(u.orgId, u.userId, poolId, body);
  }

  @Delete(":poolId/members/:candidateId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("hr:employees:manage")
  @Validate({ params: poolIdcandidateIdParams })
  async removeMember(
    @Param("poolId", ParseIntPipe) poolId: number,
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.pools.removeMember(u.orgId, poolId, candidateId);
  }
}
