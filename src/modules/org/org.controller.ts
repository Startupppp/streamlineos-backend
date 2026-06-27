import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { BranchContext } from "../leads/branch-filter";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrgMembersService } from "./org-members.service";
import { OrgSetupService } from "./org-setup.service";
import { setupSchema, type SetupInput } from "./dto/org.schemas";

@Controller("org")
@UseGuards(JwtAuthGuard)
export class OrgController {
  constructor(
    private readonly members: OrgMembersService,
    private readonly setup: OrgSetupService,
  ) {}

  @Get("members")
  listMembers(@CurrentUser() u: CurrentUserContext) {
    const ctx: BranchContext = { role: u.role, branchId: u.branchId, userId: u.userId };
    return this.members.listMembers(u.orgId, ctx);
  }

  @Patch("setup")
  completeSetup(
    @Body(new ZodValidationPipe(setupSchema)) body: SetupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.completeSetup(u, body);
  }
}
