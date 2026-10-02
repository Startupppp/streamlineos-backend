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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PortfoliosService } from "./portfolios.service";
import {
  createPortfolioSchema,
  linkProjectSchema,
  listPortfoliosQuerySchema,
  portfolioDetailQuerySchema,
  updatePortfolioSchema,
  type CreatePortfolioInput,
  type LinkProjectInput,
  type ListPortfoliosQuery,
  type PortfolioDetailQuery,
  type UpdatePortfolioInput,
} from "./dto/portfolios.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  portfolioRowSchema,
  portfolioPageSchema,
  portfolioDetailSchema,
  successSchema,
} from "./dto/portfolios-response.schemas";

const portfolioIdParams = z.object({ portfolioId: z.coerce.number().int().positive() }).strict();
const portfolioIdprojectIdParams = z.object({ portfolioId: z.coerce.number().int().positive(), projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PortfoliosController {
  constructor(private readonly svc: PortfoliosService) {}

  @Get("portfolios")
  @RequirePermission("build:portfolios:view")
  @ResponseSchema(portfolioPageSchema)
  @Validate({ query: listPortfoliosQuerySchema })
  listPortfolios(
    @Query() query: ListPortfoliosQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPortfolios(u, query);
  }

  @Get("portfolios/:portfolioId")
  @RequirePermission("build:portfolios:view")
  @ResponseSchema(portfolioDetailSchema)
  @Validate({ params: portfolioIdParams, query: portfolioDetailQuerySchema })
  getPortfolio(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Query() query: PortfolioDetailQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getPortfolio(u, portfolioId, query);
  }

  @Post("portfolios")
  @HttpCode(201)
  @RequirePermission("build:portfolios:manage")
  @ResponseSchema(portfolioRowSchema)
  @Validate({ body: createPortfolioSchema })
  createPortfolio(
    @Body() body: CreatePortfolioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPortfolio(u.orgId, u.userId, body);
  }

  @Patch("portfolios/:portfolioId")
  @RequirePermission("build:portfolios:manage")
  @ResponseSchema(portfolioRowSchema)
  @Validate({ params: portfolioIdParams, body: updatePortfolioSchema })
  updatePortfolio(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Body() body: UpdatePortfolioInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePortfolio(u.orgId, u.userId, portfolioId, body);
  }

  @Delete("portfolios/:portfolioId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("build:portfolios:manage")
  @Validate({ params: portfolioIdParams })
  deletePortfolio(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deletePortfolio(u.orgId, u.userId, portfolioId);
  }

  @Post("portfolios/:portfolioId/projects")
  @HttpCode(200)
  @RequirePermission("build:portfolios:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: portfolioIdParams, body: linkProjectSchema })
  linkProject(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Body() body: LinkProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.linkProject(u, portfolioId, body);
  }

  @Delete("portfolios/:portfolioId/projects/:projectId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("build:portfolios:manage")
  @Validate({ params: portfolioIdprojectIdParams })
  unlinkProject(
    @Param("portfolioId", ParseIntPipe) portfolioId: number,
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.unlinkProject(u, portfolioId, projectId);
  }
}
