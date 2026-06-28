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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UserApiTokensService } from "./user-api-tokens.service";
import {
  createUserApiTokenSchema,
  type CreateUserApiTokenInput,
} from "./dto/user-api-tokens.schemas";

@Controller("me/api-tokens")
@UseGuards(JwtAuthGuard)
export class UserApiTokensController {
  constructor(private readonly userApiTokensService: UserApiTokensService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.userApiTokensService.list(u.userId);
  }

  @Post()
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createUserApiTokenSchema)) body: CreateUserApiTokenInput,
  ) {
    return this.userApiTokensService.create(u.userId, body);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    return this.userApiTokensService.revoke(u.userId, tokenId);
  }
}
