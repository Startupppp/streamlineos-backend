import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { InboundIngressService } from "./inbound-ingress.service";
import { inboundEventSchema, type InboundEventBody } from "./dto/inbound-event.schemas";

/**
 * The seam, as an endpoint.
 *
 * One route for every channel. A provider adapter's whole job is to turn its own
 * payload into this shape and POST it — which is what lets the entire autonomous
 * pipeline be driven from a fixture in tests with no provider SDK anywhere.
 *
 * Gated on a CRM key rather than left open: an unauthenticated ingress is an
 * endpoint that writes parties and activities into any tenant that can be named.
 */
@Controller("crm/ingress")
@UseGuards(JwtAuthGuard)
export class InboundIngressController {
  constructor(private readonly ingress: InboundIngressService) {}

  @Post("inbound")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:ingress:submit")
  @HttpCode(202)
  @Validate({ body: inboundEventSchema })
  accept(@Body() body: InboundEventBody) {
    return this.ingress.accept(body);
  }
}
