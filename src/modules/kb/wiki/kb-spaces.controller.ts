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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbSpaceListSchema,
  kbSpaceFullSchema,
  kbSpaceSuccessSchema,
} from "./dto/kb-wiki-response.schemas";
import { accountableMembershipId } from "../../../common/auth/principal";
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
  @ResponseSchema(kbSpaceListSchema)
  async list(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const scope = await resolveKbSpacesViewScope(this.access, u);
    return await this.spaces.list(u, scope);
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
    return await this.spaces.remove(u.orgId, spaceId);
  }
}
