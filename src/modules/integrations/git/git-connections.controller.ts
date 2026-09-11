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
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  gitConnectionsListResponseSchema,
  gitConnectionCreateResponseSchema,
  gitConnectionUpdateResponseSchema,
  gitConnectionDeleteResponseSchema,
} from "./dto/git-connections-response.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { GitConnectionsService } from "./git-connections.service";
import {
  createGitConnectionSchema,
  gitConnectionsListSchema,
  updateGitConnectionSchema,
  type CreateGitConnectionInput,
  type GitConnectionsListInput,
  type UpdateGitConnectionInput,
} from "./dto/git-connections.schemas";

const connectionIdParams = z
  .object({ connectionId: z.coerce.number().int().positive() })
  .strict();

@Controller("integrations/git/connections")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class GitConnectionsController {
  constructor(private readonly connections: GitConnectionsService) {}

  @Get()
  @ResponseSchema(gitConnectionsListResponseSchema)
  @RequirePermission("integrations:git:view")
  @Validate({ query: gitConnectionsListSchema })
  listConnections(
    @Query() query: GitConnectionsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.connections.listConnections(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @Idempotent("integrations.gitConnection.create")
  @ResponseSchema(gitConnectionCreateResponseSchema)
  @RequirePermission("integrations:git:manage")
  @Validate({ body: createGitConnectionSchema })
  createConnection(
    @Body() body: CreateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.connections.createConnection(u.orgId, u.userId, body);
  }

  @Patch(":connectionId")
  @ResponseSchema(gitConnectionUpdateResponseSchema)
  @RequirePermission("integrations:git:manage")
  @Validate({ params: connectionIdParams, body: updateGitConnectionSchema })
  updateConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @Body() body: UpdateGitConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.connections.updateConnection(u.orgId, connectionId, body);
  }

  @Delete(":connectionId")
  @ResponseSchema(gitConnectionDeleteResponseSchema)
  @RequirePermission("integrations:git:manage")
  @Validate({ params: connectionIdParams })
  deleteConnection(
    @Param("connectionId", ParseIntPipe) connectionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.connections.deleteConnection(u.orgId, connectionId);
  }
}
