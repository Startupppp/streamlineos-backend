import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
} from "@nestjs/common";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CrmMcpService, type McpToolCall } from "./crm-mcp.service";
import type { Request } from "express";

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    orgId: string;
  };
}

@Controller("crm/mcp")
@UseGuards(JwtAuthGuard)
export class CrmMcpController {
  constructor(private readonly crmMcpService: CrmMcpService) {}

  /**
   * Authorized per tool, not per route.
   *
   * Every tool carries its own `requiredPermission`; `getAvailableTools` filters
   * the catalogue by what the caller holds and `executeTool` re-checks before it
   * runs. A single `@RequirePermission` here would have to name one key for a
   * surface whose whole point is that the key differs per tool, and it would
   * advertise a second, weaker way in.
   */
  @AuthorizedInService("CrmMcpService")
  @Get("tools")
  async listTools(@Req() req: AuthenticatedRequest) {
    const context = { userId: req.user.userId, orgId: req.user.orgId };
    const tools = await this.crmMcpService.getAvailableTools(context);
    return { tools };
  }

  @AuthorizedInService("CrmMcpService")
  @Post("call")
  async callTool(@Req() req: AuthenticatedRequest, @Body() body: McpToolCall) {
    const context = { userId: req.user.userId, orgId: req.user.orgId };
    return this.crmMcpService.executeTool(context, body);
  }
}
