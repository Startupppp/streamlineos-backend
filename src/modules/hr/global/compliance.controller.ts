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
import { ComplianceRequirementsService } from "./compliance-requirements.service";
import {
  createComplianceRequirementSchema,
  updateComplianceRequirementSchema,
  listComplianceRequirementSchema,
  listComplianceEventsSchema,
  markEventDoneSchema,
  seedCountryPackSchema,
  type CreateComplianceRequirementInput,
  type UpdateComplianceRequirementInput,
  type ListComplianceRequirementInput,
  type ListComplianceEventsInput,
  type MarkEventDoneInput,
  type SeedCountryPackInput,
} from "./dto/hr-global.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const requirementIdParams = z.object({ requirementId: z.coerce.number().int().positive() }).strict();
const eventIdParams = z.object({ eventId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/global/compliance")
@UseGuards(JwtAuthGuard)
export class ComplianceController {
  constructor(private readonly service: ComplianceRequirementsService) {}

  @Get("requirements")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ query: listComplianceRequirementSchema })
  listRequirements(
    @Query() query: ListComplianceRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRequirements(u.orgId, query);
  }

  @Get("requirements/:requirementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ params: requirementIdParams })
  getRequirement(
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getRequirement(u.orgId, requirementId);
  }

  @Post("requirements")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(201)
  @Validate({ body: createComplianceRequirementSchema })
  createRequirement(
    @Body() body: CreateComplianceRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createRequirement(u.orgId, u.userId, body);
  }

  @Patch("requirements/:requirementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ params: requirementIdParams, body: updateComplianceRequirementSchema })
  updateRequirement(
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @Body() body: UpdateComplianceRequirementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateRequirement(u.orgId, requirementId, u.userId, body);
  }

  @Delete("requirements/:requirementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ params: requirementIdParams })
  deleteRequirement(
    @Param("requirementId", ParseIntPipe) requirementId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteRequirement(u.orgId, requirementId, u.userId);
  }

  @Get("events")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @Validate({ query: listComplianceEventsSchema })
  listEvents(
    @Query() query: ListComplianceEventsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listEvents(u.orgId, query);
  }

  @Post("events/:eventId/done")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(200)
  @Validate({ params: eventIdParams, body: markEventDoneSchema })
  markEventDone(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Body() body: MarkEventDoneInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.markEventDone(u.orgId, eventId, u.userId, body);
  }

  @Post("generate-events")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(200)
  generateEvents(
    @Query("requirementId") requirementId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reqId = requirementId ? Number(requirementId) : undefined;
    return this.service.generateEvents(u.orgId, reqId);
  }

  @Post("seed-country-pack")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:compliance:manage")
  @HttpCode(200)
  @Validate({ body: seedCountryPackSchema })
  seedCountryPack(
    @Body() body: SeedCountryPackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.seedCountryPack(u.orgId, u.userId, body);
  }
}
