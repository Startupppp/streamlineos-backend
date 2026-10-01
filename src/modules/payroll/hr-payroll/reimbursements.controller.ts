import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
  Query,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { ReimbursementsService } from "./reimbursements.service";
import { resolveReimbursementsScope } from "./reimbursements-scope";
import { HR_PAYROLL_LIST_PERMISSION } from "./hr-payroll-permissions";
import { AccessService } from "../../access/access.service";
import {
  createReimbursementSchema,
  patchReimbursementSchema,
  type CreateReimbursementInput,
  type PatchReimbursementInput,
  listPageQuerySchema,
  type ListPageQueryInput,
} from "./dto/payroll.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  reimbursementListResponseSchema,
  reimbursementCreatedSchema,
  successSchema,
} from "./dto/hr-payroll-response.schemas";
import { z } from "zod";

const reimbursementIdParams = z
  .object({ reimbursementId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("payroll")
@Controller("hr/reimbursements")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class HrPayrollReimbursementsController {
  constructor(
    private readonly reimbursements: ReimbursementsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission(HR_PAYROLL_LIST_PERMISSION)
  @Validate({ query: listPageQuerySchema })
  @ResponseSchema(reimbursementListResponseSchema)
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListPageQueryInput,
  ) {
    const read = await resolveReimbursementsScope(this.access, u);
    return this.reimbursements.listReimbursements(
      read,
      actingMembershipId(u.principal),
      query.page ?? 1,
      query.limit ?? 100,
    );
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(HR_PAYROLL_LIST_PERMISSION)
  @Validate({ body: createReimbursementSchema })
  @ResponseSchema(reimbursementCreatedSchema)
  create(
    @Body() body: CreateReimbursementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.createReimbursement(
      u.orgId,
      u.userId,
      actingMembershipId(u.principal),
      body,
    );
  }

  @Patch(":reimbursementId")
  @RequirePermission(HR_PAYROLL_LIST_PERMISSION)
  @Validate({ params: reimbursementIdParams, body: patchReimbursementSchema })
  @ResponseSchema(successSchema)
  async update(
    @Param("reimbursementId", ParseIntPipe) reimbursementId: number,
    @Body() body: PatchReimbursementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      // Org-wide only; team-scoped approvers go through the manager inbox's reporting-line check.
      if (perms.get("hr:expenses:approve") !== "all") {
        throw new ForbiddenException("Only admins can process reimbursements.");
      }
    }

    const result = await this.reimbursements.updateStatus(
      u.orgId,
      u.userId,
      reimbursementId,
      body,
    );
    if (!result.ok) {
      if (result.reason === "not_found")
        throw new NotFoundException("Not found.");
      throw new ForbiddenException(
        "You cannot approve or reject your own reimbursement.",
      );
    }
    return { success: true };
  }
}
