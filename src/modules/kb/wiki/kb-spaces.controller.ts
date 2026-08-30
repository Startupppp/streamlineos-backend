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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { KbSpacesService } from "./kb-spaces.service";
import { resolveKbSpacesViewScope } from "../core/kb-scope";
import {
  createSpaceSchema,
  updateSpaceSchema,
  type CreateSpaceInput,
  type UpdateSpaceInput,
} from "../core/dto/kb.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const spaceIdParams = z.object({ spaceId: z.coerce.number().int().positive() }).strict();

@Controller("kb/spaces")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSpacesController {
  constructor(
    private readonly spaces: KbSpacesService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("kb:spaces:view")
  async list(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const scope = await resolveKbSpacesViewScope(this.access, u);
    return await this.spaces.list(u, scope);
  }

  @Post()
  @RequirePermission("kb:spaces:manage")
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createSpaceSchema)) body: CreateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.create(u.orgId, u.userId, body);
  }

  @Get(":spaceId")
  @RequirePermission("kb:spaces:view")
  @Validate({ params: spaceIdParams })
  async get(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.get(u, spaceId);
  }

  @Patch(":spaceId")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdParams })
  async update(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body(new ZodValidationPipe(updateSpaceSchema)) body: UpdateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.update(u.orgId, spaceId, body);
  }

  @Delete(":spaceId")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdParams })
  async remove(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.remove(u.orgId, spaceId);
  }
}
