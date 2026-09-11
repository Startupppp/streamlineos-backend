import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Public } from "../../../common/auth/public.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { PortalAuthService } from "./portal-auth.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { mintedTokenSchema } from "./dto/portal-auth-response.schemas";
import {
  acceptInvitationSchema,
  type AcceptInvitationInput,
} from "./dto/portal-auth.schemas";

@Controller("portal/auth")
@Public()
export class PortalAuthController {
  constructor(private readonly svc: PortalAuthService) {}

  @Post("accept-invitation")
  @HttpCode(200)
  @ResponseSchema(mintedTokenSchema)
  @Validate({ body: acceptInvitationSchema })
  acceptInvitation(@Body() body: AcceptInvitationInput) {
    return this.svc.acceptInvitation(body.token);
  }
}
