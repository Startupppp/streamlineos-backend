import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
} from "@nestjs/common";
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

  @Get("tools")
  async listTools(@Req() req: AuthenticatedRequest) {
    const context = { userId: req.user.userId, orgId: req.user.orgId };
    const tools = await this.crmMcpService.getAvailableTools(context);
    return { tools };
  }

  @Post("call")
  async callTool(@Req() req: AuthenticatedRequest, @Body() body: McpToolCall) {
    const context = { userId: req.user.userId, orgId: req.user.orgId };
    return this.crmMcpService.executeTool(context, body);
  }
}
