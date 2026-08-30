import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ApiTokensService } from "./api-tokens.service";
import {
  createApiTokenSchema,
  listApiTokensSchema,
  type CreateApiTokenInput,
  type ListApiTokensQuery,
} from "./dto/api-tokens.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const tokenIdParams = z.object({ tokenId: z.string().min(1) }).strict();

@Controller("api-tokens")
@RequireModule("crm")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:settings:manage")
  listTokens(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listApiTokensSchema))
    query: ListApiTokensQuery,
  ) {
    return this.apiTokensService.listTokens(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:settings:manage")
  createToken(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createApiTokenSchema))
    body: CreateApiTokenInput,
  ) {
    return this.apiTokensService.createToken(u.orgId, u.userId, body);
  }

  @Patch(":tokenId/revoke")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:settings:manage")
  @Validate({ params: tokenIdParams })
  revokeToken(
    @CurrentUser() u: CurrentUserContext,
    @Param("tokenId") tokenId: string,
  ) {
    return this.apiTokensService.revokeToken(u.orgId, tokenId);
  }
}
