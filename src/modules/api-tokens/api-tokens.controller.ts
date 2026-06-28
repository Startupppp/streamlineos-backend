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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  listTokens(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listApiTokensSchema)) query: ListApiTokensQuery,
  ) {
    return this.apiTokensService.listTokens(u.orgId, query);
  }

  @Post()
  createToken(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createApiTokenSchema)) body: CreateApiTokenInput,
  ) {
    this.apiTokensService.assertCanManage(u.role);
    return this.apiTokensService.createToken(u.orgId, u.userId, body);
  }

  @Patch(":tokenId/revoke")
  @HttpCode(HttpStatus.OK)
  revokeToken(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    this.apiTokensService.assertCanManage(u.role);
    return this.apiTokensService.revokeToken(u.orgId, tokenId);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteToken(@CurrentUser() u: CurrentUserContext, @Param("tokenId") tokenId: string) {
    this.apiTokensService.assertCanManage(u.role);
    return this.apiTokensService.deleteToken(u.orgId, tokenId);
  }
}
