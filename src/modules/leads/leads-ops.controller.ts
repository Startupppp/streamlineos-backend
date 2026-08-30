import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { LeadsImportService } from "./leads-import.service";
import { LeadsOpsService } from "./leads-ops.service";
import {
  bulkDeleteSchema,
  bulkUpdateSchema,
  distributeSchema,
  importSchema,
  topMergeSchema,
  type BulkDeleteInput,
  type BulkUpdateInput,
  type DistributeInput,
  type ImportInput,
  type TopMergeInput,
} from "./dto/lead-mutations.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const batchIdParams = z.object({ batchId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("leads")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeadsOpsController {
  constructor(
    private readonly ops: LeadsOpsService,
    private readonly imports: LeadsImportService,
  ) {}

  @Get("import/:batchId")
  @RequirePermission("crm:leads:view")
  @Validate({ params: batchIdParams })
  async getImportBatch(
    @Param("batchId", ParseIntPipe) batchId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const batch = await this.ops.getImportBatch(u.orgId, batchId);
    if (!batch) throw new NotFoundException("Batch not found");
    return batch;
  }

  @Patch("bulk")
  @RequirePermission("crm:leads:update")
  bulkUpdate(
    @Body(new ZodValidationPipe(bulkUpdateSchema)) body: BulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkUpdate(u.orgId, u.userId, body);
  }

  @Delete("bulk")
  @RequirePermission("crm:leads:delete")
  bulkDelete(
    @Body(new ZodValidationPipe(bulkDeleteSchema)) body: BulkDeleteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ops.bulkDelete(u.orgId, body);
  }

  @Post("merge")
  @HttpCode(200)
  @RequirePermission("crm:leads:assign")
  async mergeLeads(
    @Body(new ZodValidationPipe(topMergeSchema)) body: TopMergeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.ops.mergeLeads(u.orgId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "self") {
        throw new BadRequestException("Cannot merge a lead with itself");
      }
      if (result.reason === "winner_not_found") {
        throw new NotFoundException("Winner lead not found");
      }
      throw new NotFoundException("Loser lead not found");
    }
    return { merged: true, winner: result.winner };
  }

  @Post("import")
  @RequirePermission("crm:leads:create")
  @HttpCode(201)
  @Idempotent("crm.leads.import")
  importLeads(
    @Body(new ZodValidationPipe(importSchema)) body: ImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.importLeads(u.orgId, u.userId, body);
  }

  @Post("distribute")
  @HttpCode(200)
  @RequirePermission("crm:leads:assign")
  async distribute(
    @Body(new ZodValidationPipe(distributeSchema)) body: DistributeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.ops.distribute(u.orgId, u.userId, body);
    if (!result.ok) {
      if (result.reason === "no_members") {
        throw new BadRequestException("No organization members found");
      }
      if (result.reason === "no_sales") {
        throw new BadRequestException("No active sales team members found.");
      }
      if (result.reason === "all_on_leave") {
        throw new BadRequestException("All sales team members are on leave today.");
      }
      throw new NotFoundException("No valid leads found to distribute");
    }
    return result.data;
  }
}
