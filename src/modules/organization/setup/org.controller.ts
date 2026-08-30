import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";
import { setupSchema, type SetupInput } from "./dto/org.schemas";
import { AllowNoOrg } from "../../../common/auth/allow-no-org.decorator";
import {
  orgSetupSkipSchema,
  type OrgSetupSkipInput,
} from "../../hr/onboarding/flow/dto/onboarding-flow.schemas";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";

@Controller("org")
@UseGuards(JwtAuthGuard)
export class OrgController {
  constructor(
    private readonly members: OrgMembersService,
    private readonly setup: OrgSetupService,
  ) {}

  @Get("members")
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:people:view")
  listMembers(
    @CurrentUser() u: CurrentUserContext,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.members.listMembers(u.orgId, {
      search: typeof search === "string" ? search : undefined,
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
    });
  }

  @Get("setup/session")
  @Universal()
  @AllowNoOrg()
  getSetupSession(@CurrentUser() u: CurrentUserContext) {
    return this.setup.getSetupSession(u);
  }

  @Post("setup/complete")
  @Universal()
  @AllowNoOrg()
  @Validate({ body: setupSchema })
  complete(
    @Body() body: SetupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.completeSetup(u, body);
  }

  @Post("setup/skip")
  @Universal()
  @AllowNoOrg()
  @Validate({ body: orgSetupSkipSchema })
  skip(
    @Body() body: OrgSetupSkipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.skipSetup(u, body.reason);
  }
}
