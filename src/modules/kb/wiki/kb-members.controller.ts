import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbMembersService } from "./kb-members.service";
import { addMemberSchema, type AddMemberInput } from "./dto/kb-members.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { z } from "zod";

const spaceIdParams = z.object({ spaceId: z.coerce.number().int().positive() }).strict();
const spaceIdmemberIdParams = z.object({ spaceId: z.coerce.number().int().positive(), memberId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireModule("kb")
export class KbMembersController {
  constructor(private readonly members: KbMembersService) {}

  @Get("spaces/:spaceId/members")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdParams })
  async list(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.members.list(u.orgId, spaceId);
  }

  @Post("spaces/:spaceId/members")
  @RequirePermission("kb:spaces:manage")
  @HttpCode(201)
  @Validate({ params: spaceIdParams, body: addMemberSchema })
  async add(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body() body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.members.add(u.orgId, spaceId, body);
  }

  @Delete("spaces/:spaceId/members/:memberId")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdmemberIdParams })
  async remove(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Param("memberId", ParseIntPipe) memberId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.members.remove(u.orgId, spaceId, memberId);
  }
}
