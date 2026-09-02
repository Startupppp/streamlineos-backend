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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const incidentIdParams = z.object({ incidentId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/incidents")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IncidentsController {
  constructor(private readonly svc: IncidentsService) {}

  @Get()
  @RequirePermission("build:incidents:view")
  @Validate({ query: listIncidentsQuerySchema })
  listIncidents(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListIncidentsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listIncidents(u, projectId, query);
  }

  @Get(":incidentId")
  @RequirePermission("build:incidents:view")
  @Validate({ params: incidentIdParams })
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
  @Validate({ body: createIncidentSchema })
  createIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateIncidentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createIncident(u, projectId, body);
  }

  @Patch(":incidentId")
  @RequirePermission("build:incidents:manage")
  @Validate({ params: incidentIdParams, body: updateIncidentSchema })
  updateIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: UpdateIncidentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateIncident(u.orgId, u.userId, projectId, incidentId, body);
  }

  @Delete(":incidentId")
  @RequirePermission("build:incidents:manage")
  @HttpCode(204)
  @Validate({ params: incidentIdParams })
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
  @Validate({ params: incidentIdParams, body: addIncidentUpdateSchema })
  addUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: AddIncidentUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addUpdate(u.orgId, u.userId, projectId, incidentId, body);
  }
}
