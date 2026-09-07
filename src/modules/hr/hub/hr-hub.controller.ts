import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
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
import { HrHubService } from "./hr-hub.service";
import type { HrHubSnapshot } from "./hr-hub.types";

const hrHubSectionSchema = z.union([
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  z.object({ status: z.literal("error"), code: z.string(), message: z.string() }),
]);

const hrHubSnapshotSchema = z.object({
  generatedAt: z.string(),
  today: z.string(),
  capabilities: z.record(z.string(), z.boolean()),
  sections: z.record(z.string(), hrHubSectionSchema.nullable()),
});

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
