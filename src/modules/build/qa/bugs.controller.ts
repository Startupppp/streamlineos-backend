import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
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
import { BugsService } from "./bugs.service";
import {
  bugListQuerySchema,
  createBugSchema,
  updateBugSchema,
  type BugListQuery,
  type CreateBugInput,
  type UpdateBugInput,
} from "./dto/bugs.schemas";

@RequireModule("build")
@Controller("build/:projectId/bugs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BugsController {
  constructor(private readonly svc: BugsService) {}

  @Get()
  @RequirePermission("build:bugs:view")
  listBugs(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(bugListQuerySchema)) query: BugListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listBugs(u.orgId, projectId, query);
  }

  @Get(":bugId")
  @RequirePermission("build:bugs:view")
  getBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("bugId", ParseIntPipe) bugId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getBug(u.orgId, projectId, bugId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:bugs:create")
  createBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createBugSchema)) body: CreateBugInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createBug(u.orgId, u.userId, projectId, body);
  }

  @Patch(":bugId")
  @RequirePermission("build:bugs:update")
  updateBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("bugId", ParseIntPipe) bugId: number,
    @Body(new ZodValidationPipe(updateBugSchema)) body: UpdateBugInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateBug(u.orgId, u.userId, projectId, bugId, body);
  }

  @Delete(":bugId")
  @RequirePermission("build:bugs:delete")
  @HttpCode(204)
  deleteBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("bugId", ParseIntPipe) bugId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteBug(u.orgId, projectId, bugId);
  }
}
