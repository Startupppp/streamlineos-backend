import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { UserApiTokensService } from "./user-api-tokens.service";
import {
  createUserApiTokenSchema,
  type CreateUserApiTokenInput,
} from "./dto/user-api-tokens.schemas";

@Controller("me/api-tokens")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UserApiTokensController {
  constructor(private readonly userApiTokensService: UserApiTokensService) {}

  @Get()
  @RequirePermission("settings:api-tokens:read")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.userApiTokensService.list(u.userId);
  }

  @Post()
  @RequirePermission("settings:api-tokens:write")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createUserApiTokenSchema)) body: CreateUserApiTokenInput,
  ) {
    return this.userApiTokensService.create(u.userId, u.orgId, body);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission("settings:api-tokens:write")
  revoke(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    return this.userApiTokensService.revoke(u.userId, tokenId);
  }
}
