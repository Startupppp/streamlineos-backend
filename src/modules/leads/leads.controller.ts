import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { LeadsService, isAssigneeNotMember } from "./leads.service";
import {
  createSchema,
  listSchema,
  updateSchema,
  type CreateInput,
  type ListInput,
  type UpdateInput,
} from "./dto/lead.schemas";

@Controller("leads")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @CheckAbility("read", "crm:leads")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leads.listLeads(u.orgId, {
      ...filters,
      role: u.role || undefined,
      userId: u.userId,
      branch: { role: u.role, branchId: u.branchId, userId: u.userId },
    });
  }

  @Post()
  @CheckAbility("create", "crm:leads")
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
  getBoard(@CurrentUser() u: CurrentUserContext) {
    return this.leads.getBoard(u.orgId, {
      role: u.role || undefined,
      userId: u.userId,
      branch: { role: u.role, branchId: u.branchId, userId: u.userId },
    });
  }

  @Get("stats")
  getStats(
    @Query("dateFrom") dateFrom: string | undefined,
    @Query("dateTo") dateTo: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leads.getStats(u.orgId, {
      dateFrom,
      dateTo,
      role: u.role || undefined,
      userId: u.userId,
      branch: { role: u.role, branchId: u.branchId, userId: u.userId },
    });
  }

  @Get(":leadId")
  async get(@Param("leadId", ParseIntPipe) leadId: number, @CurrentUser() u: CurrentUserContext) {
    const lead = await this.leads.getLead(u.orgId, leadId);
    if (!lead) throw new NotFoundException("Lead not found");
    return lead;
  }

  @Patch(":leadId")
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
  @CheckAbility("delete", "crm:leads")
  remove(@Param("leadId", ParseIntPipe) leadId: number, @CurrentUser() u: CurrentUserContext) {
    return this.leads.remove(u.orgId, u.userId, leadId);
  }
}
