import {
  Body,
  Controller,
  Get,
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
import { AccessService } from "../../access/access.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import {
  createHeadcountSchema,
  headcountListSchema,
  rejectHeadcountSchema,
  updateHeadcountSchema,
  type CreateHeadcountInput,
  type HeadcountListInput,
  type RejectHeadcountInput,
  type UpdateHeadcountInput,
} from "./dto/sourcing.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { actingMembershipId } from "../../../common/auth/principal";
import { z } from "zod";
import {
  headcountListPageSchema,
  headcountRowSchema,
  createJobFromRequisitionResponseSchema,
} from "./dto/recruitment-response.schemas";

const requestIdParams = z.object({ requestId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/recruitment")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecruitmentHeadcountController {
  constructor(
    private readonly sourcing: RecruitmentSourcingService,
    private readonly access: AccessService,
  ) {}

  @Get("headcount")
  @ResponseSchema(headcountListPageSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: headcountListSchema })
  async listHeadcount(
    @Query() query: HeadcountListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canManage = u.isOrgOwner
      || (await this.access.resolveUserPermissions(u.orgId, u.userId)).has("hr:requisitions:manage");
    return this.sourcing.listHeadcount(u.orgId, u.userId, canManage, query, actingMembershipId(u.principal));
  }

  @Post("headcount")
  @ResponseSchema(headcountRowSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ body: createHeadcountSchema })
  createHeadcount(
    @Body() body: CreateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.createHeadcount(u.orgId, u.userId, body, actingMembershipId(u.principal));
  }

  @Patch("headcount/:requestId")
  @ResponseSchema(headcountRowSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: requestIdParams, body: updateHeadcountSchema })
  updateHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: UpdateHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.updateHeadcount(u.orgId, u.userId, requestId, body, actingMembershipId(u.principal));
  }

  @Post("headcount/:requestId/approve")
  @BodylessAction()
  @Idempotent("hr.headcount.approve")
  @ResponseSchema(headcountRowSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: requestIdParams })
  approveHeadcount(@Param("requestId", ParseIntPipe) requestId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.approveHeadcount(u.orgId, u.userId, requestId, actingMembershipId(u.principal));
  }

  @Post("headcount/:requestId/reject")
  @Idempotent("hr.headcount.reject")
  @ResponseSchema(headcountRowSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: requestIdParams, body: rejectHeadcountSchema })
  rejectHeadcount(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: RejectHeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sourcing.rejectHeadcount(u.orgId, requestId, body.reason);
  }

  @Post("headcount/:requestId/create-job")
  @BodylessAction()
  @ResponseSchema(createJobFromRequisitionResponseSchema)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: requestIdParams })
  createJobFromHeadcount(@Param("requestId", ParseIntPipe) requestId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sourcing.createJobFromHeadcount(u.orgId, u.userId, requestId);
  }
}
