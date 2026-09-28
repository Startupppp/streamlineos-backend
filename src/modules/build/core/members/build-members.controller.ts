import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { BuildMembersService } from "./build-members.service";
import {
  addBuildMemberSchema,
  listBuildMembersSchema,
  type AddBuildMemberInput,
  type ListBuildMembersInput,
} from "../dto/build-members.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  buildMemberPageSchema,
  buildMemberRowSchema,
} from "../dto/build-core-response.schemas";

const userIdParams = z.object({ userId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build/members")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BuildMembersController {
  constructor(private readonly members: BuildMembersService) {}

  @Get()
  @RequirePermission("build:members:view")
  @ResponseSchema(buildMemberPageSchema)
  @Validate({ query: listBuildMembersSchema })
  list(
    @Query() query: ListBuildMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("build:members:manage")
  @HttpCode(201)
  @ResponseSchema(buildMemberRowSchema)
  @Validate({ body: addBuildMemberSchema })
  add(
    @Body() body: AddBuildMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.add(u.orgId, u.userId, body);
  }

  @Delete(":userId")
  @RequirePermission("build:members:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: userIdParams })
  remove(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.remove(u.orgId, u.userId, userId);
  }
}
