import {
  Body,
  Header,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { NO_COMPRESSION_HEADER } from "../../../common/http/compression.config";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { UserApiTokensService } from "./user-api-tokens.service";
import {
  createUserApiTokenSchema,
  type CreateUserApiTokenInput,
  listUserApiTokensSchema,
  type ListUserApiTokensInput,
} from "./dto/user-api-tokens.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const tokenIdParams = z.object({ tokenId: z.string().min(1) }).strict();

@Controller("me/api-tokens")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UserApiTokensController {
  constructor(private readonly userApiTokensService: UserApiTokensService) {}

  @Get()
  @RequirePermission("settings:api-tokens:read")
  @Validate({ query: listUserApiTokensSchema })
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListUserApiTokensInput,
  ) {
    return this.userApiTokensService.list(u.userId, query);
  }

  @Get("permissions")
  @RequirePermission("settings:api-tokens:read")
  listGrantablePermissions(@CurrentUser() u: CurrentUserContext) {
    return this.userApiTokensService.listGrantablePermissions(u);
  }

  @Post()
  @RequirePermission("settings:api-tokens:write")
  @Validate({ body: createUserApiTokenSchema })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateUserApiTokenInput,
  ) {
    return this.userApiTokensService.create(u, body);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission("settings:api-tokens:write")
  @Validate({ params: tokenIdParams })
  revoke(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    return this.userApiTokensService.revoke(u.userId, tokenId);
  }
}
