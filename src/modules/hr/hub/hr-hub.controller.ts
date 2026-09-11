import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import {
  hrHubQuerySchema,
  type HrHubQuery,
} from "./dto/hr-hub.schemas";
import { hrHubSnapshotSchema } from "./dto/hr-hub-response.schemas";
import { HrHubService } from "./hr-hub.service";
import type { HrHubSnapshot } from "./hr-hub.types";

@RequireModule("hr")
@Controller("hr/hub")
@UseGuards(JwtAuthGuard)
export class HrHubController {
  constructor(private readonly hub: HrHubService) {}

  @Get()
  @ResponseSchema(hrHubSnapshotSchema)
  @AuthorizedInService("HrHubService.getSnapshot narrows every panel through buildHrHubCapabilities")
  @Validate({ query: hrHubQuerySchema })
  getSnapshot(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: HrHubQuery,
  ): Promise<HrHubSnapshot> {
    return this.hub.getSnapshot(user, query.today);
  }
}
