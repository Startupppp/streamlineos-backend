import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";
import { setupSchema, type SetupInput } from "./dto/org.schemas";
import { AllowNoOrg } from "../../../common/auth/allow-no-org.decorator";
import {
  orgSetupSkipSchema,
  type OrgSetupSkipInput,
} from "../../hr/onboarding/flow/dto/onboarding-flow.schemas";

@Controller("org")
@UseGuards(JwtAuthGuard)
export class OrgController {
  constructor(
    private readonly members: OrgMembersService,
    private readonly setup: OrgSetupService,
  ) {}

  @Get("members")
  listMembers(
    @CurrentUser() u: CurrentUserContext,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.members.listMembers(u.orgId, {
      search: typeof search === "string" ? search : undefined,
      limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get("setup/session")
  @AllowNoOrg()
  getSetupSession(@CurrentUser() u: CurrentUserContext) {
    return this.setup.getSetupSession(u);
  }

  @Post("setup/complete")
  @AllowNoOrg()
  complete(
    @Body(new ZodValidationPipe(setupSchema)) body: SetupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.completeSetup(u, body);
  }

  @Post("setup/skip")
  @AllowNoOrg()
  skip(
    @Body(new ZodValidationPipe(orgSetupSkipSchema)) body: OrgSetupSkipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.skipSetup(u, body.reason);
  }
}
