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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TerminationService } from "./termination.service";
import {
  terminationCreateSchema,
  terminationReviewSchema,
  listTerminationsQuerySchema,
  type TerminationCreateInput,
  type TerminationReviewInput,
  type ListTerminationsQueryInput,
} from "./dto/hr-lifecycle.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  terminationListSchema,
  terminationRowSchema,
  terminationLetterSchema,
  terminationDetailSchema,
  successSchema,
} from "./dto/lifecycle-response.schemas";

const terminationIdParams = z.object({ terminationId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/termination")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TerminationController {
  constructor(private readonly termination: TerminationService) {}

  @Get()
  @ResponseSchema(terminationListSchema)
  @RequirePermission("hr:exit:manage")
  @Validate({ query: listTerminationsQuerySchema })
  list(
    @Query() query: ListTerminationsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(terminationRowSchema)
  @HttpCode(201)
  @RequirePermission("hr:exit:manage")
  @Validate({ body: terminationCreateSchema })
  create(
    @Body() body: TerminationCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.create(
      u.orgId,
      u.userId,
      u.isOrgOwner,
      body,
    );
  }

  @Post(":terminationId/send-email")
  @ResponseSchema(successSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("hr:exit:manage")
  @Validate({ params: terminationIdParams })
  sendEmail(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.sendEmail(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/complete")
  @ResponseSchema(successSchema)
  @BodylessAction()
  @RequirePermission("hr:exit:manage")
  @Validate({ params: terminationIdParams })
  complete(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.complete(u.orgId, u.userId, terminationId);
  }

  @Get(":terminationId/letter")
  @ResponseSchema(terminationLetterSchema)
  @RequirePermission("hr:exit:manage")
  @Validate({ params: terminationIdParams })
  getLetter(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.getLetter(u.orgId, terminationId);
  }

  @Patch(":terminationId/submit")
  @ResponseSchema(successSchema)
  @BodylessAction()
  @Idempotent("hr.termination.submit")
  @RequirePermission("hr:exit:manage")
  @Validate({ params: terminationIdParams })
  submit(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.submit(u.orgId, u.userId, terminationId);
  }

  @Patch(":terminationId/final-review")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:exit:approve")
  @Validate({ params: terminationIdParams, body: terminationReviewSchema })
  finalReview(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @Body() body: TerminationReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.finalReview(u.orgId, u.userId, terminationId, body);
  }

  @Get(":terminationId")
  @ResponseSchema(terminationDetailSchema)
  @RequirePermission("hr:exit:manage")
  @Validate({ params: terminationIdParams })
  getOne(
    @Param("terminationId", ParseIntPipe) terminationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.termination.getOne(u.orgId, terminationId);
  }
}
