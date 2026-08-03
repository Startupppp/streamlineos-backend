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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsWorkspaceMembersService } from "./projects-workspace-members.service";
import {
  addWorkspaceMemberSchema,
  listWorkspaceMembersSchema,
  type AddWorkspaceMemberInput,
  type ListWorkspaceMembersInput,
} from "./dto/projects-workspace-members.schemas";

@RequireModule("build")
@Controller("build/members")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsWorkspaceMembersController {
  constructor(private readonly workspace: ProjectsWorkspaceMembersService) {}

  @Get()
  @RequirePermission("build:members:view")
  list(
    @Query(new ZodValidationPipe(listWorkspaceMembersSchema))
    query: ListWorkspaceMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("build:members:manage")
  @HttpCode(201)
  add(
    @Body(new ZodValidationPipe(addWorkspaceMemberSchema))
    body: AddWorkspaceMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.add(u.orgId, u.userId, body);
  }

  @Delete(":userId")
  @RequirePermission("build:members:manage")
  @HttpCode(204)
  remove(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.remove(u.orgId, u.userId, userId);
  }
}
