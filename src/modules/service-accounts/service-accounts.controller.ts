import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ServiceAccountsService } from "./service-accounts.service";
import {
  createServiceAccountSchema,
  updateServiceAccountSchema,
  listServiceAccountsSchema,
  type CreateServiceAccountInput,
  type UpdateServiceAccountInput,
  type ListServiceAccountsQuery,
} from "./dto/service-accounts.schemas";

@Controller("service-accounts")
@UseGuards(JwtAuthGuard, AbilityGuard)
@CheckAbility("manage", "settings")
export class ServiceAccountsController {
  constructor(private readonly svc: ServiceAccountsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listServiceAccountsSchema)) query: ListServiceAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createServiceAccountSchema)) body: CreateServiceAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":serviceAccountId")
  update(
    @Param("serviceAccountId") serviceAccountId: string,
    @Body(new ZodValidationPipe(updateServiceAccountSchema)) body: UpdateServiceAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, serviceAccountId, body);
  }

  @Delete(":serviceAccountId")
  remove(@Param("serviceAccountId") serviceAccountId: string, @CurrentUser() u: CurrentUserContext) {
    return this.svc.remove(u.orgId, u.userId, serviceAccountId);
  }

  @Post(":serviceAccountId/rotate-key")
  @HttpCode(200)
  rotateKey(@Param("serviceAccountId") serviceAccountId: string, @CurrentUser() u: CurrentUserContext) {
    return this.svc.rotateKey(u.orgId, u.userId, serviceAccountId);
  }
}
