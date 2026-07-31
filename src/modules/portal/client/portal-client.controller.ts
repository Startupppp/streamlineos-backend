import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { PortalJwtAuthGuard } from "../../../common/portal-auth/portal-jwt-auth.guard";
import type { PortalUserContext } from "../../../common/portal-auth/portal-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PortalClientService } from "./portal-client.service";
import {
  submitChangeRequestSchema,
  type SubmitChangeRequestInput,
} from "./dto/portal-client.schemas";

type PortalReq = Request & { portalUser: PortalUserContext };

@Controller("portal/v1")
@UseGuards(PortalJwtAuthGuard)
export class PortalClientController {
  constructor(private readonly svc: PortalClientService) {}

  @Get("projects")
  listProjects(@Req() req: PortalReq) {
    const ctx = req.portalUser;
    return this.svc.listGrantedProjects(
      ctx.organizationId,
      String(ctx.portalMembershipId),
    );
  }

  @Get("projects/:projectId/overview")
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
  submitChangeRequest(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(submitChangeRequestSchema))
    body: SubmitChangeRequestInput,
    @Req() req: PortalReq,
  ) {
    const ctx = req.portalUser;
    return this.svc.submitChangeRequest(
      ctx.organizationId,
      String(ctx.portalMembershipId),
      ctx.userId,
      projectId,
      body,
    );
  }
}
