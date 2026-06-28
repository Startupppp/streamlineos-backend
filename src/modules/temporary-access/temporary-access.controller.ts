import { Body, Controller, Delete, Param, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  TemporaryAccessService,
  createTemporaryAccessSchema,
  type CreateTemporaryAccessInput,
} from "./temporary-access.service";

@Controller("access/temporary")
@UseGuards(JwtAuthGuard)
export class TemporaryAccessController {
  constructor(private readonly service: TemporaryAccessService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createTemporaryAccessSchema)) body: CreateTemporaryAccessInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Delete(":id")
  revoke(@Param("id") id: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.revoke(u.orgId, Number(id));
  }
}
