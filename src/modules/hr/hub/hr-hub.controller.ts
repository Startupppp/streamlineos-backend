import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import {
  hrHubQuerySchema,
  type HrHubQuery,
} from "./dto/hr-hub.schemas";
import { HrHubService } from "./hr-hub.service";
import type { HrHubSnapshot } from "./hr-hub.types";

@RequireModule("hr")
@Controller("hr/hub")
@UseGuards(JwtAuthGuard)
export class HrHubController {
  constructor(private readonly hub: HrHubService) {}

  @Get()
  getSnapshot(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(hrHubQuerySchema)) query: HrHubQuery,
  ): Promise<HrHubSnapshot> {
    return this.hub.getSnapshot(user, query.today);
  }
}
