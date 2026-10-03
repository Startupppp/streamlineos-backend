import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import { ImpersonationService } from "./impersonation.service";
import { startImpersonationSchema } from "./dto/impersonation.schemas";
import {
  startImpersonationResponseSchema,
  stopImpersonationResponseSchema,
} from "./dto/impersonation-response.schemas";

const impersonationSessionIdParam = z.object({
  impersonationSessionId: z.string().uuid(),
});

@Controller("impersonation")
@UseGuards(JwtAuthGuard)
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Post("start")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:impersonate:manage")
  @Validate({ body: startImpersonationSchema })
  @ResponseSchema(startImpersonationResponseSchema)
  start(
    @Body() body: z.infer<typeof startImpersonationSchema>,
    @CurrentUser() actor: CurrentUserContext,
  ) {
    return this.impersonation.start(actor, body.targetUserId);
  }

  @Delete("stop/:impersonationSessionId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:impersonate:manage")
  @Validate({ params: impersonationSessionIdParam })
  @ResponseSchema(stopImpersonationResponseSchema)
  stop(
    @Param("impersonationSessionId") impersonationSessionId: string,
    @CurrentUser() actor: CurrentUserContext,
  ) {
    return this.impersonation.stop(actor, impersonationSessionId);
  }
}
