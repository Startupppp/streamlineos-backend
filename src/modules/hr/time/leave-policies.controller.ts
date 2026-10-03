import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { LeavePoliciesService } from "./leave-policies.service";
import { LeavePolicyTemplatesService } from "./leave-policy-templates.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  leavePolicyRowSchema,
  leavePolicyTemplateDismissSchema,
  leavePolicyTemplateImportSchema,
  leavePolicyTemplateOfferSchema,
} from "./dto/time-leave-response.schemas";
import {
  createLeavePolicySchema,
  importLeavePolicyTemplatesSchema,
  updateLeavePolicySchema,
  type CreateLeavePolicyBody,
  type ImportLeavePolicyTemplatesBody,
  type UpdateLeavePolicyBody,
} from "./dto/leaves.schemas";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/leave-policies")
export class LeavePoliciesController {
  constructor(
    private readonly service: LeavePoliciesService,
    private readonly templates: LeavePolicyTemplatesService,
  ) {}

  /**
   * Ticket 08. What a newly created organisation is offered on its first visit,
   * and whether it should be offered at all. `hr:leaves:manage`, because the
   * only thing to do with the answer is create policies.
   */
  @Get("templates")
  @ResponseSchema(leavePolicyTemplateOfferSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  templateOffer(@CurrentUser() u: CurrentUserContext) {
    return this.templates.offer(u.orgId);
  }

  @Post("templates/dismiss")
  @HttpCode(200)
  @BodylessAction()
  @ResponseSchema(leavePolicyTemplateDismissSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  dismissTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.templates.dismiss(u.orgId, u.userId);
  }

  @Post("templates/import")
  @HttpCode(201)
  @ResponseSchema(leavePolicyTemplateImportSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Idempotent("hr.leave-policy-templates.import")
  @Validate({ body: importLeavePolicyTemplatesSchema })
  importTemplates(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: ImportLeavePolicyTemplatesBody,
  ) {
    return this.templates.importTemplates(u.orgId, body.items);
  }

  @Get()
  @ResponseSchema(z.array(leavePolicyRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(leavePolicyRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ body: createLeavePolicySchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateLeavePolicyBody,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":policyId")
  @ResponseSchema(leavePolicyRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: policyIdParams, body: updateLeavePolicySchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdateLeavePolicyBody,
  ) {
    return this.service.update(u.orgId, policyId, body);
  }

  @Delete(":policyId")
  @HttpCode(204)
  @NoContentResponse()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: policyIdParams })
  remove(@CurrentUser() u: CurrentUserContext, @Param("policyId", ParseIntPipe) policyId: number) {
    return this.service.remove(u.orgId, policyId);
  }
}
