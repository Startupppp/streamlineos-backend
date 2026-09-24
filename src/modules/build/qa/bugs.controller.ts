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
import { BugsService } from "./bugs.service";
import {
  bugListQuerySchema,
  createBugSchema,
  updateBugSchema,
  type BugListQuery,
  type CreateBugInput,
  type UpdateBugInput,
} from "./dto/bugs.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { bugRowSchema } from "./dto/qa-response.schemas";

const bugRouteParams = z
  .object({
    projectId: z.coerce.number().int().positive(),
    bugId: z.coerce.number().int().positive(),
  })
  .strict();

@RequireModule("build")
@Controller("build/:projectId/bugs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BugsController {
  constructor(private readonly svc: BugsService) {}

  @Get()
  @RequirePermission("build:bugs:view")
  @ResponseSchema(z.array(bugRowSchema))
  @Validate({ query: bugListQuerySchema })
  listBugs(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: BugListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listBugs(u, projectId, query);
  }

  @Get(":bugId")
  @RequirePermission("build:bugs:view")
  @ResponseSchema(bugRowSchema)
  @Validate({ params: bugRouteParams })
  getBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("bugId", ParseIntPipe) bugId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getBug(u, projectId, bugId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:bugs:create")
  @ResponseSchema(bugRowSchema)
  @Validate({ body: createBugSchema })
  createBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateBugInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createBug(u, projectId, body);
  }

  @Patch(":bugId")
  @RequirePermission("build:bugs:update")
  @ResponseSchema(bugRowSchema)
  @Validate({ params: bugRouteParams, body: updateBugSchema })
  updateBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("bugId", ParseIntPipe) bugId: number,
    @Body() body: UpdateBugInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateBug(u, projectId, bugId, body);
  }

  @Delete(":bugId")
  @RequirePermission("build:bugs:delete")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: bugRouteParams })
  deleteBug(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("bugId", ParseIntPipe) bugId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteBug(u, projectId, bugId);
  }
}
