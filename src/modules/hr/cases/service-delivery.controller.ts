import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ServiceDeliveryInboxService } from "./service-delivery-inbox.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { opsInboxResponseSchema, myItemsResponseSchema } from "./dto/cases-response.schemas";

@RequireModule("hr")
@Controller("hr/service-delivery")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ServiceDeliveryController {
  constructor(private readonly inbox: ServiceDeliveryInboxService) {}

  /**
   * Unified ops inbox: open cases + safety incidents + helpdesk tickets.
   * Permission-filtered per domain.
   */
  @Get("ops-inbox")
  @ResponseSchema(opsInboxResponseSchema)
  @RequirePermission("hr:cases:view")
  getOpsInbox(@CurrentUser() u: CurrentUserContext) {
    return this.inbox.getOpsInbox(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  /** Employee: my open helpdesk tickets + cases I reported. */
  @Get("my-items")
  @ResponseSchema(myItemsResponseSchema)
  @RequirePermission("hr:helpdesk:view")
  getMyItems(@CurrentUser() u: CurrentUserContext) {
    return this.inbox.getMyItems(u.orgId, u.userId, actingMembershipId(u.principal));
  }
}
