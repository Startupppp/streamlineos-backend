import {
  Body,
  Header,
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
import { NO_COMPRESSION_HEADER } from "../../../common/http/compression.config";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ApiTokensService } from "./api-tokens.service";
import {
  createApiTokenSchema,
  listApiTokensSchema,
  type CreateApiTokenInput,
  type ListApiTokensQuery,
} from "./dto/api-tokens.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
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
  @Validate({ query: listApiTokensSchema })
  listTokens(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListApiTokensQuery,
  ) {
    return this.apiTokensService.listTokens(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:settings:manage")
  // PRD-C089 (BREACH) — this body is the plaintext API key, returned exactly once, `app.enableCors({ credentials: true })`
  // is live, and a compressed length is a cross-origin size oracle. `shouldCompress` checks
  // this opt-out first, so no content type can overrule it.
  @Header(NO_COMPRESSION_HEADER, "1")
  @Validate({ body: createApiTokenSchema })
  createToken(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateApiTokenInput,
  ) {
    return this.apiTokensService.createToken(u.orgId, u.userId, body);
  }

  @Patch(":tokenId/revoke")
  @BodylessAction()
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
