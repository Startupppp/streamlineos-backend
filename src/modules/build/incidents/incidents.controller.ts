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
  addIncidentDecisionSchema,
  addIncidentUpdateSchema,
  createFollowUpActionSchema,
  createIncidentSchema,
  incidentChildrenQuerySchema,
  listIncidentsQuerySchema,
  updateFollowUpActionSchema,
  updateIncidentSchema,
  type AddIncidentDecisionInput,
  type AddIncidentUpdateInput,
  type CreateFollowUpActionInput,
  type CreateIncidentInput,
  type IncidentChildrenQuery,
  type ListIncidentsQuery,
  type UpdateFollowUpActionInput,
  type UpdateIncidentInput,
} from "./dto/incidents.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import {
  NoContentResponse,
  ResponseSchema,
} from "../../../common/openapi/zod-operation-contracts";
import {
  incidentRowSchema,
  incidentDetailSchema,
  incidentUpdateRowSchema,
  incidentDecisionRowSchema,
  incidentFollowUpActionRowSchema,
} from "./dto/incidents-response.schemas";

export const incidentIdParams = z
  .object({
    projectId: z.coerce.number().int().positive(),
    incidentId: z.coerce.number().int().positive(),
  })
  .strict();

export const incidentFollowUpIdParams = z
  .object({
    projectId: z.coerce.number().int().positive(),
    incidentId: z.coerce.number().int().positive(),
    followUpActionId: z.coerce.number().int().positive(),
  })
  .strict();

@RequireModule("build")
@Controller("build/:projectId/incidents")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IncidentsController {
  constructor(private readonly svc: IncidentsService) {}

  @Get()
  @RequirePermission("build:incidents:view")
  @ResponseSchema(z.array(incidentRowSchema))
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
  @ResponseSchema(incidentDetailSchema)
  @Validate({ params: incidentIdParams, query: incidentChildrenQuerySchema })
  getIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Query() query: IncidentChildrenQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getIncident(u, projectId, incidentId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:incidents:manage")
  @ResponseSchema(incidentRowSchema)
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
  @ResponseSchema(incidentRowSchema)
  @Validate({ params: incidentIdParams, body: updateIncidentSchema })
  updateIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: UpdateIncidentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateIncident(u, projectId, incidentId, body);
  }

  @Delete(":incidentId")
  @RequirePermission("build:incidents:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: incidentIdParams })
  deleteIncident(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteIncident(u, projectId, incidentId);
  }

  @Post(":incidentId/updates")
  @HttpCode(201)
  @RequirePermission("build:incidents:manage")
  @ResponseSchema(incidentUpdateRowSchema)
  @Validate({ params: incidentIdParams, body: addIncidentUpdateSchema })
  addUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: AddIncidentUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addUpdate(u, projectId, incidentId, body);
  }

  @Post(":incidentId/decisions")
  @HttpCode(201)
  @RequirePermission("build:incidents:manage")
  @ResponseSchema(incidentDecisionRowSchema)
  @Validate({ params: incidentIdParams, body: addIncidentDecisionSchema })
  addDecision(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: AddIncidentDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addDecision(u, projectId, incidentId, body);
  }

  @Post(":incidentId/follow-ups")
  @HttpCode(201)
  @RequirePermission("build:incidents:manage")
  @ResponseSchema(incidentFollowUpActionRowSchema)
  @Validate({ params: incidentIdParams, body: createFollowUpActionSchema })
  addFollowUpAction(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Body() body: CreateFollowUpActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addFollowUpAction(u, projectId, incidentId, body);
  }

  @Patch(":incidentId/follow-ups/:followUpActionId")
  @RequirePermission("build:incidents:manage")
  @ResponseSchema(incidentFollowUpActionRowSchema)
  @Validate({ params: incidentFollowUpIdParams, body: updateFollowUpActionSchema })
  updateFollowUpAction(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("incidentId", ParseIntPipe) incidentId: number,
    @Param("followUpActionId", ParseIntPipe) followUpActionId: number,
    @Body() body: UpdateFollowUpActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateFollowUpAction(u, projectId, incidentId, followUpActionId, body);
  }
}
