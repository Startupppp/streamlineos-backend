import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbSpacesService } from "./kb-spaces.service";
import {
  createSpaceSchema,
  updateSpaceSchema,
  type CreateSpaceInput,
  type UpdateSpaceInput,
} from "./dto/kb.schemas";

@Controller("kb/spaces")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbSpacesController {
  constructor(private readonly spaces: KbSpacesService) {}

  @Get()
  @RequirePermission("kb:spaces:view")
  async list(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return await this.spaces.list(u);
  }

  @Post()
  @RequirePermission("kb:spaces:manage")
  async create(
    @Body(new ZodValidationPipe(createSpaceSchema)) body: CreateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.create(u.orgId, u.userId, body);
  }

  @Get(":spaceId")
  @RequirePermission("kb:spaces:view")
  async get(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.get(u, spaceId);
  }

  @Patch(":spaceId")
  @RequirePermission("kb:spaces:manage")
  async update(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body(new ZodValidationPipe(updateSpaceSchema)) body: UpdateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.update(u.orgId, spaceId, body);
  }

  @Delete(":spaceId")
  @RequirePermission("kb:spaces:manage")
  async remove(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.remove(u.orgId, spaceId);
  }
}
