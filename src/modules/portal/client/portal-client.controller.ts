import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PortalJwtAuthGuard } from "../../../common/portal-auth/portal-jwt-auth.guard";
import { PortalRoute } from "../../../common/portal-auth/portal-route.decorator";
import type { PortalUserContext } from "../../../common/portal-auth/portal-claims";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { PortalClientService } from "./portal-client.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  clientProjectListSchema,
  projectOverviewSchema,
  changeRequestSchema,
} from "./dto/portal-client-response.schemas";
import {
  submitChangeRequestSchema,
  type SubmitChangeRequestInput,
} from "./dto/portal-client.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

type PortalReq = Request & {
  portalUser: PortalUserContext;
  user?: { orgId: string; userId: string; sessionId: string };
};

const portalCommandPrincipalGuard: CanActivate = {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<PortalReq>();
    const principalId = `portal:${String(request.portalUser.portalMembershipId)}`;
    request.user = {
      orgId: request.portalUser.organizationId,
      userId: principalId,
      sessionId: principalId,
    };
    return true;
  },
};

@Controller("portal/v1")
@PortalRoute()
@UseGuards(PortalJwtAuthGuard)
@AuthorizedInService(
  "PortalJwtAuthGuard, then PortalClientService scopes every read to the portal membership's granted projects",
)
export class PortalClientController {
  constructor(private readonly svc: PortalClientService) {}

  @Get("projects")
  @ResponseSchema(clientProjectListSchema)
  listProjects(@Req() req: PortalReq) {
    const ctx = req.portalUser;
    return this.svc.listGrantedProjects(
      ctx.organizationId,
      String(ctx.portalMembershipId),
    );
  }

  @Get("projects/:projectId/overview")
  @ResponseSchema(projectOverviewSchema)
  @Validate({ params: projectIdParams })
  getProjectOverview(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Req() req: PortalReq,
  ) {
    const ctx = req.portalUser;
    return this.svc.getProjectOverview(
      ctx.organizationId,
      String(ctx.portalMembershipId),
      projectId,
    );
  }

  @Post("projects/:projectId/change-requests")
  @HttpCode(201)
  @UseGuards(portalCommandPrincipalGuard, RateLimitGuard)
  @UseRateLimit("support:portal-ticket-create")
  @Idempotent("portal.client.change-request.create")
  @ResponseSchema(changeRequestSchema)
  @Validate({ params: projectIdParams, body: submitChangeRequestSchema })
  submitChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: SubmitChangeRequestInput,
    @Req() req: PortalReq,
  ) {
    const ctx = req.portalUser;
    return this.svc.submitChangeRequest(
      ctx.organizationId,
      String(ctx.portalMembershipId),
      ctx.userMembershipId,
      projectId,
      body,
    );
  }
}
