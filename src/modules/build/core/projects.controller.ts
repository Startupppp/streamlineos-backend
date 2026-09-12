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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsQueryService } from "./projects-query.service";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsMembersService } from "./projects-members.service";
import {
  createLabelSchema,
  createProjectSchema,
  fromDealSchema,
  listProjectsSchema,
  updateLabelSchema,
  type CreateLabelInput,
  type CreateProjectInput,
  type FromDealInput,
  type ListProjectsInput,
  type UpdateLabelInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  ticketLabelSchema,
  projectListPageSchema,
} from "./dto/build-core-response.schemas";
import { projectRowSchema } from "./dto/build-project-detail-response.schemas";

const labelIdParams = z.object({ labelId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsController {
  constructor(
    private readonly projectsQuery: ProjectsQueryService,
    private readonly projectsProvision: ProjectsProvisionService,
    private readonly members: ProjectsMembersService,
  ) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(projectListPageSchema)
  @Validate({ query: listProjectsSchema })
  listProjects(
    @Query() query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsQuery.listProjects(u, query);
  }

  @Post()
  @RequirePermission("build:create")
  @HttpCode(201)
  @ResponseSchema(projectRowSchema)
  @Idempotent("build.project.create")
  @Validate({ body: createProjectSchema })
  createProject(
    @Body() body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsProvision.createProject(u.orgId, u.userId, body);
  }

  @Post("from-deal")
  @RequirePermission("build:create")
  @HttpCode(201)
  @ResponseSchema(projectRowSchema)
  @Idempotent("build.project.create_from_deal")
  @Validate({ body: fromDealSchema })
  createFromDeal(
    @Body() body: FromDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsProvision.createFromDeal(u.orgId, u.userId, body);
  }

  @Get("labels")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(ticketLabelSchema))
  listLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post("labels")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @ResponseSchema(ticketLabelSchema)
  @Validate({ body: createLabelSchema })
  createLabel(
    @Body() body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Patch("labels/:labelId")
  @RequirePermission("build:manage")
  @ResponseSchema(ticketLabelSchema)
  @Validate({ params: labelIdParams, body: updateLabelSchema })
  updateLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @Body() body: UpdateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateLabel(u.orgId, labelId, body);
  }

  @Delete("labels/:labelId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: labelIdParams })
  deleteLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteLabel(u.orgId, labelId);
  }
}
