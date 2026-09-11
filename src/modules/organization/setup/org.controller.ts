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
import { z } from "zod";
import { optionalPageSizeField } from "../../../common/pagination/list-query.schema";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { NoTenantTransaction } from "../../../common/tenant";
import {
  orgMemberListResponseSchema,
  orgSetupSessionResponseSchema,
  orgSetupStatusResponseSchema,
  orgSetupCompleteResponseSchema,
  orgSetupSkipResponseSchema,
} from "./dto/org-setup-response.schemas";

/**
 * `Number.parseInt("-5", 10)` is -5 and `Number.isFinite(-5)` is true, so the old
 * hand-rolled guard let a negative limit through to
 * `org-members.service.ts`'s `Math.min(options.limit ?? MAX, MAX)` — which is
 * also -5 — and Postgres answered `LIMIT must not be negative` (2201W). The
 * guard only ever caught NaN.
 *
 * `optionalPageSizeField` keeps the absent case `undefined`, so the service's own
 * `MAX_MEMBER_RESULTS` default still owns that decision; what it adds is a floor
 * of 1 and the platform ceiling.
 */
const listMembersQuery = z
  .object({
    search: z.string().max(200).optional(),
    limit: optionalPageSizeField(),
  })
  .strict();
type ListMembersQuery = z.infer<typeof listMembersQuery>;

@Controller("org")
@UseGuards(JwtAuthGuard)
export class OrgController {
  constructor(
    private readonly members: OrgMembersService,
    private readonly setup: OrgSetupService,
  ) {}

  @Get("members")
  @ResponseSchema(orgMemberListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:people:view")
  @Validate({ query: listMembersQuery })
  listMembers(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListMembersQuery,
  ) {
    return this.members.listMembers(u.orgId, {
      search: query.search,
      limit: query.limit,
    });
  }

  // The org being set up need not be the session's, so an ambient transaction would mismatch.
  @Get("setup/session")
  @ResponseSchema(orgSetupSessionResponseSchema)
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  getSetupSession(@CurrentUser() u: CurrentUserContext) {
    return this.setup.getSetupSession(u);
  }

  @Get("setup/status")
  @ResponseSchema(orgSetupStatusResponseSchema)
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  getSetupStatus(@CurrentUser() u: CurrentUserContext) {
    return this.setup.getSetupStatus(u);
  }

  @Post("setup/complete")
  @ResponseSchema(orgSetupCompleteResponseSchema)
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  @Validate({ body: setupSchema })
  complete(
    @Body() body: SetupInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.completeSetup(u, body);
  }

  @Post("setup/skip")
  @ResponseSchema(orgSetupSkipResponseSchema)
  @Universal()
  @AllowNoOrg()
  @NoTenantTransaction()
  @Validate({ body: orgSetupSkipSchema })
  skip(
    @Body() body: OrgSetupSkipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.setup.skipSetup(u, body.reason);
  }
}
