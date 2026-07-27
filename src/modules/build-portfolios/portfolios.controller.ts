import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PortfoliosService } from "./portfolios.service";
import {
  createPortfolioSchema,
  linkProjectSchema,
  listPortfoliosQuerySchema,
  updatePortfolioSchema,
  type CreatePortfolioInput,
  type LinkProjectInput,
  type ListPortfoliosQuery,
  type UpdatePortfolioInput,
} from "./dto/portfolios.schemas";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PortfoliosController {
  constructor(private readonly svc: PortfoliosService) {}

  @Get("portfolios")
  @RequirePermission("build:portfolios:view")
  listPortfolios(
    @Query(new ZodValidationPipe(listPortfoliosQuerySchema)) query: ListPortfoliosQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPortfolios(u.orgId, query);
  }

  @Get("portfolios/:portfolioId")
  @RequirePermission("build:portfolios:view")
  getPortfolio(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getPortfolio(u.orgId, portfolioId);
  }

  @Post("portfolios")
  @HttpCode(201)
  @RequirePermission("build:portfolios:manage")
  createPortfolio(
    @Body(new ZodValidationPipe(createPortfolioSchema)) body: CreatePortfolioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPortfolio(u.orgId, u.userId, body);
  }

  @Patch("portfolios/:portfolioId")
  @RequirePermission("build:portfolios:manage")
  updatePortfolio(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Body(new ZodValidationPipe(updatePortfolioSchema)) body: UpdatePortfolioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePortfolio(u.orgId, u.userId, portfolioId, body);
  }

  @Delete("portfolios/:portfolioId")
  @HttpCode(204)
  @RequirePermission("build:portfolios:manage")
  deletePortfolio(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deletePortfolio(u.orgId, u.userId, portfolioId);
  }

  @Post("portfolios/:portfolioId/projects")
  @HttpCode(200)
  @RequirePermission("build:portfolios:manage")
  linkProject(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Body(new ZodValidationPipe(linkProjectSchema)) body: LinkProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.linkProject(u.orgId, u.userId, portfolioId, body);
  }

  @Delete("portfolios/:portfolioId/projects/:projectId")
  @HttpCode(204)
  @RequirePermission("build:portfolios:manage")
  unlinkProject(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.unlinkProject(u.orgId, u.userId, portfolioId, projectId);
  }
}
