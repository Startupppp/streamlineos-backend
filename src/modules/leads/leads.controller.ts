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
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const leadIdParams = z.object({ leadId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listSchema })
  async list(
    @Query() filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveLeadsViewScope(this.access, u);
    return this.leads.listLeads(u.orgId, {
      ...filters,
      scope,
      userId: u.userId,
    });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("crm:leads:create")
  @Idempotent("crm.lead.create")
  @Validate({ body: createSchema })
  async create(
    @Body() body: CreateInput,
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
    });
  }

  @Get(":leadId")
  @RequirePermission("crm:leads:view")
  @Validate({ params: leadIdParams })
  async get(@Param("leadId", ParseIntPipe) leadId: number, @CurrentUser() u: CurrentUserContext) {
    const lead = await this.leads.getLead(u.orgId, leadId);
    if (!lead) throw new NotFoundException("Lead not found");
    return lead;
  }

  @Patch(":leadId")
  @RequirePermission("crm:leads:update")
  @Validate({ params: leadIdParams, body: updateSchema })
  async update(
    @Param("leadId", ParseIntPipe) leadId: number,
    @Body() body: UpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.leads.update(u.orgId, u.userId, leadId, body);
    if (!updated) throw new NotFoundException("Lead not found");
    return updated;
  }

  @Delete(":leadId")
  @HttpCode(204)
  @RequirePermission("crm:leads:delete")
  @Validate({ params: leadIdParams })
  async remove(@Param("leadId", ParseIntPipe) leadId: number, @CurrentUser() u: CurrentUserContext) {
    await this.leads.remove(u.orgId, u.userId, leadId);
  }
}
