import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TerminationService } from "./termination.service";
import {
  terminationCreateSchema,
  terminationReviewSchema,
  listTerminationsQuerySchema,
  type TerminationCreateInput,
  type TerminationReviewInput,
  type ListTerminationsQueryInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/termination")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TerminationController {
  constructor(private readonly termination: TerminationService) {}

  @Get()
  @RequirePermission("hr:exit:manage")
  list(
    @Query(new ZodValidationPipe(listTerminationsQuerySchema)) query: ListTerminationsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:exit:manage")
  create(
    @Body(new ZodValidationPipe(terminationCreateSchema)) body: TerminationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.create(u.orgId, u.userId, u.role, body);
  }

  @Post(":terminationId/send-email")
  @HttpCode(200)
  @RequirePermission("hr:exit:manage")
  sendEmail(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.sendEmail(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/complete")
  @RequirePermission("hr:exit:manage")
  complete(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.complete(u.orgId, u.userId, terminationId);
  }

  @Get(":terminationId/letter")
  @RequirePermission("hr:exit:manage")
  getLetter(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.getLetter(u.orgId, terminationId);
  }

  @Patch(":terminationId/submit")
  @RequirePermission("hr:exit:manage")
  submit(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.submit(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/ceo-review")
  @RequirePermission("hr:exit:approve")
  ceoReview(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @Body(new ZodValidationPipe(terminationReviewSchema)) body: TerminationReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.ceoReview(u.orgId, u.userId, terminationId, body);
  }

  @Get(":terminationId")
  @RequirePermission("hr:exit:manage")
  getOne(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.getOne(u.orgId, terminationId);
  }
}
