import {
  Body,
  Controller,
  Delete,
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

@Controller("api-tokens")
@UseGuards(JwtAuthGuard)
export class ApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  listTokens(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listApiTokensSchema)) query: ListApiTokensQuery,
  ) {
    return this.apiTokensService.listTokens(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  createToken(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createApiTokenSchema)) body: CreateApiTokenInput,
  ) {
    return this.apiTokensService.createToken(u.orgId, u.userId, body);
  }

  @Patch(":tokenId/revoke")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  revokeToken(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    return this.apiTokensService.revokeToken(u.orgId, tokenId);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  deleteToken(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    return this.apiTokensService.deleteToken(u.orgId, tokenId);
  }
}
