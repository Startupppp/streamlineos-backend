import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { BranchContext } from "../leads/branch-filter";
import { OrgMembersService } from "./org-members.service";

@Controller("org")
@UseGuards(JwtAuthGuard)
export class OrgController {
  constructor(private readonly members: OrgMembersService) {}

  @Get("members")
  listMembers(@CurrentUser() u: CurrentUserContext) {
    const ctx: BranchContext = { role: u.role, branchId: u.branchId, userId: u.userId };
    return this.members.listMembers(u.orgId, ctx);
  }
}
