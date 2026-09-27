import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbSpacesService } from "./kb-spaces.service";
import { KbSpaceLifecycleService } from "./kb-space-lifecycle.service";
import { resolveKbSpacesViewScope } from "../core/kb-scope";
import {
  createSpaceSchema,
  listSpacesQuerySchema,
  updateSpaceSchema,
  type CreateSpaceInput,
  type ListSpacesQuery,
  type UpdateSpaceInput,
} from "../core/dto/kb.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import {
  BodylessAction,
  ResponseSchema,
} from "../../../common/openapi/zod-operation-contracts";
import {
  kbSpaceArchiveImpactSchema,
  kbSpaceFullSchema,
  kbSpaceListPageSchema,
  kbSpaceSuccessSchema,
} from "./dto/kb-space-response.schemas";
import { accountableMembershipId } from "../../../common/auth/principal";
import { z } from "zod";

const spaceIdParams = z
  .object({ spaceId: z.coerce.number().int().positive() })
  .strict();

@Controller("kb/spaces")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbSpacesController {
  constructor(
    private readonly spaces: KbSpacesService,
    private readonly lifecycle: KbSpaceLifecycleService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("kb:spaces:view")
  @Validate({ query: listSpacesQuerySchema })
  @ResponseSchema(kbSpaceListPageSchema)
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListSpacesQuery,
  ): Promise<unknown> {
    const scope = await resolveKbSpacesViewScope(this.access, u);
    return await this.spaces.list(u, scope, query);
  }

  @Post()
  @RequirePermission("kb:spaces:manage")
  @HttpCode(201)
  @Validate({ body: createSpaceSchema })
  @ResponseSchema(kbSpaceFullSchema)
  async create(
    @Body() body: CreateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const membershipId = accountableMembershipId(u.principal);
    if (membershipId === null) {
      throw new ForbiddenException("Organization membership required");
    }
    return await this.spaces.create(u.orgId, body, membershipId);
  }

  @Get(":spaceId")
  @RequirePermission("kb:spaces:view")
  @Validate({ params: spaceIdParams })
  @ResponseSchema(kbSpaceFullSchema)
  async get(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.get(u, spaceId);
  }

  @Patch(":spaceId")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdParams, body: updateSpaceSchema })
  @ResponseSchema(kbSpaceFullSchema)
  async update(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @Body() body: UpdateSpaceInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.spaces.update(u.orgId, spaceId, body);
  }

  @Delete(":spaceId")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdParams })
  @ResponseSchema(kbSpaceSuccessSchema)
  async remove(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.lifecycle.remove(u.orgId, spaceId);
  }

  @Get(":spaceId/archive-impact")
  @RequirePermission("kb:spaces:manage")
  @Validate({ params: spaceIdParams })
  @ResponseSchema(kbSpaceArchiveImpactSchema)
  async archiveImpact(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.lifecycle.archiveImpact(u.orgId, spaceId);
  }

  @Post(":spaceId/archive")
  @RequirePermission("kb:spaces:manage")
  @HttpCode(200)
  @Validate({ params: spaceIdParams })
  @BodylessAction()
  @ResponseSchema(kbSpaceSuccessSchema)
  async archive(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.lifecycle.archive(u.orgId, spaceId);
  }

  @Post(":spaceId/restore")
  @RequirePermission("kb:spaces:manage")
  @HttpCode(200)
  @Validate({ params: spaceIdParams })
  @BodylessAction()
  @ResponseSchema(kbSpaceSuccessSchema)
  async restore(
    @Param("spaceId", ParseIntPipe) spaceId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.lifecycle.restore(u.orgId, spaceId);
  }
}
