import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  BadRequestException,
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
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { LeadsService, isAssigneeNotMember } from "./leads.service";
import { resolveLeadsViewScope } from "./leads-scope";
import {
  createSchema,
  listSchema,
  updateSchema,
  type CreateInput,
  type ListInput,
  type UpdateInput,
} from "./dto/lead.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("leads")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequirePermission("crm:leads:view")
  async list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveLeadsViewScope(this.access, u);
    return this.leads.listLeads(u.orgId, {
      ...filters,
      scope,
      userId: u.userId,
      branch: { role: u.role, branchId: u.branchId, userId: u.userId },
    });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("crm:leads:create")
  @Idempotent("crm.lead.create")
  async create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.leads.create(u.orgId, u.userId, body);
    if (isAssigneeNotMember(result)) {
      throw new BadRequestException("Assigned user is not a member of this organization");
    }
    return result;
  }

  @Get("board")
  @RequirePermission("crm:leads:view")
  async getBoard(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveLeadsViewScope(this.access, u);
    return this.leads.getBoard(u.orgId, {
      scope,
      userId: u.userId,
      branch: { role: u.role, branchId: u.branchId, userId: u.userId },
    });
  }

  @Get("stats")
  @RequirePermission("crm:leads:view")
  async getStats(
    @Query("dateFrom") dateFrom: string | undefined,
    @Query("dateTo") dateTo: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveLeadsViewScope(this.access, u);
    return this.leads.getStats(u.orgId, {
      dateFrom,
      dateTo,
      scope,
      userId: u.userId,
      branch: { role: u.role, branchId: u.branchId, userId: u.userId },
    });
  }

  @Get(":leadId")
  @RequirePermission("crm:leads:view")
  async get(@Param("leadId", ParseIntPipe) leadId: number, @CurrentUser() u: CurrentUserContext) {
    const lead = await this.leads.getLead(u.orgId, leadId);
    if (!lead) throw new NotFoundException("Lead not found");
    return lead;
  }

  @Patch(":leadId")
  @RequirePermission("crm:leads:update")
  async update(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.leads.update(u.orgId, u.userId, leadId, body);
    if (!updated) throw new NotFoundException("Lead not found");
    return updated;
  }

  @Delete(":leadId")
  @HttpCode(204)
  @RequirePermission("crm:leads:delete")
  async remove(@Param("leadId", ParseIntPipe) leadId: number, @CurrentUser() u: CurrentUserContext) {
    await this.leads.remove(u.orgId, u.userId, leadId);
  }
}
