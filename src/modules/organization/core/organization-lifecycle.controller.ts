import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { AllowNoOrg } from "../../../common/auth/allow-no-org.decorator";
import { NoTenantTransaction } from "../../../common/tenant";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { assertOwnerOnly } from "../../../common/rbac/owner-only-operations";
import { assertPathOrgIsCallerOrg } from "./assert-path-org";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgPurgeService } from "./org-purge.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { OrganizationLegalHoldService } from "./lifecycle/organization-legal-hold.service";
import {
  restoreOrgSchema,
  deleteOrgSchema,
  schedulePurgeSchema,
  placeLegalHoldSchema,
  type RestoreOrgInput,
  type DeleteOrgInput,
  type SchedulePurgeInput,
  type PlaceLegalHoldInput,
} from "./dto/organization.schemas";
import {
  archiveOrgResponseSchema,
  restoreOrgResponseSchema,
  leaveOrgResponseSchema,
  deleteOrgResponseSchema,
  schedulePurgeResponseSchema,
  cancelPurgeResponseSchema,
  placeLegalHoldResponseSchema,
  legalHoldListResponseSchema,
  releaseLegalHoldResponseSchema,
} from "./dto/organization-core-response.schemas";
import { z } from "zod";

const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();
const holdIdParams = z.object({ holdId: z.string().min(1) }).strict();

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationLifecycleController {
  constructor(
    private readonly orgLifecycle: OrgLifecycleService,
    private readonly orgPurge: OrgPurgeService,
    private readonly orgMemberDeparture: OrgMemberDepartureService,
    private readonly legalHold: OrganizationLegalHoldService,
  ) {}

  @Post("archive")
  @BodylessAction()
  @ResponseSchema(archiveOrgResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  archiveOrg(@CurrentUser() u: CurrentUserContext) {
    assertOwnerOnly(u, "organization.archive");
    return this.orgLifecycle.archiveOrg(u.orgId, u.userId);
  }

  @Post("restore")
  @ResponseSchema(restoreOrgResponseSchema)
  @HttpCode(200)
  @AuthorizedInService("OrgLifecycleService.restoreOrg — an ACTIVE isOwner membership of the target org, 404 on a miss")
  @AllowNoOrg()
  @NoTenantTransaction()
  @Validate({ body: restoreOrgSchema })
  restoreOrg(
    @Body() body: RestoreOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgLifecycle.restoreOrg(body.orgId, u.userId);
  }

  @Post("leave")
  @BodylessAction()
  @ResponseSchema(leaveOrgResponseSchema)
  @Universal()
  @HttpCode(200)
  leaveOrg(@CurrentUser() u: CurrentUserContext) {
    return this.orgMemberDeparture.leaveOrg(u.orgId, u.userId);
  }

  @Delete()
  @ResponseSchema(deleteOrgResponseSchema)
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ body: deleteOrgSchema })
  deleteOrg(
    @Body() body: DeleteOrgInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.delete");
    return this.orgPurge.deleteOrg(u.orgId, u.userId, body.confirmation);
  }

  @Post(":orgId/purge/schedule")
  @ResponseSchema(schedulePurgeResponseSchema)
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: orgIdParams, body: schedulePurgeSchema })
  schedulePurge(
    @Param("orgId") orgId: string,
    @Body() body: SchedulePurgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.purge.schedule");
    assertPathOrgIsCallerOrg(orgId, u.orgId);
    const targetOrgId = u.orgId;
    return this.orgPurge.schedulePurge(
      targetOrgId,
      u.userId,
      body.scheduledForDays,
      body.reason,
    );
  }

  @Delete(":orgId/purge")
  @ResponseSchema(cancelPurgeResponseSchema)
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  @Validate({ params: orgIdParams })
  cancelPurge(
    @Param("orgId") orgId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.purge.cancel");
    assertPathOrgIsCallerOrg(orgId, u.orgId);
    const targetOrgId = u.orgId;
    return this.orgPurge.cancelPurge(targetOrgId, u.userId);
  }

  @Post("legal-holds")
  @ResponseSchema(placeLegalHoldResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: placeLegalHoldSchema })
  placeLegalHold(
    @Body() body: PlaceLegalHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.legal-hold");
    return this.legalHold.place(u.orgId, u.userId, body.reason);
  }

  @Get("legal-holds")
  @ResponseSchema(legalHoldListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  listLegalHolds(@CurrentUser() u: CurrentUserContext) {
    return this.legalHold.listActive(u.orgId);
  }

  @Delete("legal-holds/:holdId")
  @ResponseSchema(releaseLegalHoldResponseSchema)
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: holdIdParams })
  releaseLegalHold(
    @Param("holdId") holdId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    assertOwnerOnly(u, "organization.legal-hold");
    return this.legalHold.release(holdId, u.orgId, u.userId);
  }
}
