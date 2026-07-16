import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { WorkspaceSearchService } from "./workspace-search.service";
import { askBodySchema, searchQuerySchema } from "./dto/workspace-search.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("ai:search:use")
@Controller("workspace-search")
export class WorkspaceSearchController {
  constructor(private readonly svc: WorkspaceSearchService) {}

  @Get()
  async search(
    @Query() query: unknown,
    @Req() req: Request & { user: CurrentUserContext },
  ) {
    const parsed = searchQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.svc.search(req.user, parsed.data);
  }

  @Post("ask")
  async ask(
    @Body() body: unknown,
    @Req() req: Request & { user: CurrentUserContext },
  ) {
    const parsed = askBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.svc.ask(req.user, parsed.data);
  }
}
