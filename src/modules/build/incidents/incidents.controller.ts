import {
  Body,
  Controller,
  Delete,
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { IncidentsService } from "./incidents.service";
import {
  addIncidentUpdateSchema,
  createIncidentSchema,
  listIncidentsQuerySchema,
  updateIncidentSchema,
  type AddIncidentUpdateInput,
  type CreateIncidentInput,
  type ListIncidentsQuery,
  type UpdateIncidentInput,
} from "./dto/incidents.schemas";

@RequireModule("build")
@Controller("build/:projectId/incidents")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IncidentsController {
  constructor(private readonly svc: IncidentsService) {}

  @Get()
  @RequirePermission("build:incidents:view")
  listIncidents(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listIncidentsQuerySchema)) query: ListIncidentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listIncidents(u.orgId, projectId, query);
  }

  @Get(":incidentId")
  @RequirePermission("build:incidents:view")
  getIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getIncident(u.orgId, projectId, incidentId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:incidents:manage")
  createIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createIncidentSchema)) body: CreateIncidentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createIncident(u.orgId, u.userId, projectId, body);
  }

  @Patch(":incidentId")
  @RequirePermission("build:incidents:manage")
  updateIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body(new ZodValidationPipe(updateIncidentSchema)) body: UpdateIncidentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateIncident(u.orgId, u.userId, projectId, incidentId, body);
  }

  @Delete(":incidentId")
  @RequirePermission("build:incidents:manage")
  @HttpCode(204)
  deleteIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteIncident(u.orgId, u.userId, projectId, incidentId);
  }

  @Post(":incidentId/updates")
  @HttpCode(201)
  @RequirePermission("build:incidents:manage")
  addUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body(new ZodValidationPipe(addIncidentUpdateSchema)) body: AddIncidentUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addUpdate(u.orgId, u.userId, projectId, incidentId, body);
  }
}
