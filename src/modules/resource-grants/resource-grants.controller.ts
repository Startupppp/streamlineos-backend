import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  ResourceGrantsService,
  createResourceGrantSchema,
  type CreateResourceGrantInput,
} from "./resource-grants.service";

@Controller("access/resource-grants")
@UseGuards(JwtAuthGuard)
export class ResourceGrantsController {
  constructor(private readonly service: ResourceGrantsService) {}

  @Get()
  list(
    @Query("resourceType") resourceType: string,
    @Query("resourceId") resourceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, resourceType ?? "", resourceId ?? "");
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createResourceGrantSchema)) body: CreateResourceGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Delete(":grantId")
  remove(@Param("grantId") grantId: string, @CurrentUser() u: CurrentUserContext) {
    return this.service.remove(u, grantId);
  }
}
