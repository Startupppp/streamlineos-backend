import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  DelegationsService,
  createDelegationSchema,
  type CreateDelegationInput,
} from "./delegations.service";

@Controller("access/delegations")
@UseGuards(JwtAuthGuard)
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId, u.userId);
  }

  @Get("given")
  listGiven(@CurrentUser() u: CurrentUserContext) {
    return this.service.listGiven(u.orgId, u.userId);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createDelegationSchema)) body: CreateDelegationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Delete(":id")
  revoke(@Param("id") id: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.revoke(u.orgId, id, u);
  }
}
