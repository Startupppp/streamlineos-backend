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
import { ReimbursementsService } from "./reimbursements.service";
import { resolveReimbursementsScope } from "./reimbursements-scope";
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
import { z } from "zod";

const reimbursementIdParams = z.object({ reimbursementId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("hr/reimbursements")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ReimbursementsController {
  constructor(
    private readonly reimbursements: ReimbursementsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("hr:payroll:view")
  @Validate({ query: listPageQuerySchema })
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListPageQueryInput,
  ) {
    const scope = await resolveReimbursementsScope(this.access, u);
    return this.reimbursements.listReimbursements(u.orgId, u.userId, scope, query.page ?? 1, query.limit ?? 100);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:payroll:view")
  @Validate({ body: createReimbursementSchema })
  create(
    @Body() body: CreateReimbursementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reimbursements.createReimbursement(u.orgId, u.userId, body);
  }

  @Patch(":reimbursementId")
  @RequirePermission("hr:payroll:view")
  @Validate({ params: reimbursementIdParams, body: patchReimbursementSchema })
  async update(
    @Param("reimbursementId", ParseIntPipe) reimbursementId: number,
    @Body() body: PatchReimbursementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:expenses:approve")) {
        throw new ForbiddenException("Only admins can process reimbursements.");
      }
    }

    const result = await this.reimbursements.updateStatus(u.orgId, u.userId, reimbursementId, body);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("Not found.");
      throw new ForbiddenException("You cannot approve or reject your own reimbursement.");
    }
    return { success: true };
  }
}
