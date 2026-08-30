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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsWorkspaceMembersService } from "./projects-workspace-members.service";
import {
  addWorkspaceMemberSchema,
  listWorkspaceMembersSchema,
  type AddWorkspaceMemberInput,
  type ListWorkspaceMembersInput,
} from "./dto/projects-workspace-members.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const userIdParams = z.object({ userId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build/members")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsWorkspaceMembersController {
  constructor(private readonly workspace: ProjectsWorkspaceMembersService) {}

  @Get()
  @RequirePermission("build:members:view")
  @Validate({ query: listWorkspaceMembersSchema })
  list(
    @Query() query: ListWorkspaceMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("build:members:manage")
  @HttpCode(201)
  @Validate({ body: addWorkspaceMemberSchema })
  add(
    @Body() body: AddWorkspaceMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.add(u.orgId, u.userId, body);
  }

  @Delete(":userId")
  @RequirePermission("build:members:manage")
  @HttpCode(204)
  @Validate({ params: userIdParams })
  remove(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.remove(u.orgId, u.userId, userId);
  }
}
