import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PortalAuthService } from "./portal-auth.service";
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
  acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationSchema))
    body: AcceptInvitationInput,
  ) {
    return this.svc.acceptInvitation(body.token);
  }
}
