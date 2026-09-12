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
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsMembersService } from "./projects-members.service";
import {
  addMemberSchema,
  bulkReorderStatesSchema,
  createLabelSchema,
  createStateSchema,
  removeMemberSchema,
  updateCustomStateSchema,
  updateProjectMemberRoleSchema,
  type AddMemberInput,
  type BulkReorderStatesInput,
  type CreateLabelInput,
  type CreateStateInput,
  type RemoveMemberInput,
  type UpdateCustomStateInput,
  type UpdateProjectMemberRoleInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  ticketLabelSchema,
  projectMemberSchema,
  projectRosterSchema,
  projectMemberRowSchema,
  memberRoleSchema,
  projectCustomStateSchema,
  bulkReorderStatesResultSchema,
} from "./dto/build-core-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdmemberUserIdParams = z.object({ projectId: z.coerce.number().int().positive(), memberUserId: z.string().min(1) }).strict();
const projectIdstateIdParams = z.object({ projectId: z.coerce.number().int().positive(), stateId: z.coerce.number().int().positive() }).strict();
const projectIdParams_ = z.object({ projectId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectResourcesController {
  constructor(private readonly members: ProjectsMembersService) {}

  @Get(":projectId/members")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(projectMemberSchema))
  @Validate({ params: projectIdParams })
  listMembers(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listMembers(u, projectId);
  }

  @Get(":projectId/roster")
  @RequirePermission("build:view")
  @ResponseSchema(projectRosterSchema)
  @Validate({ params: projectIdParams })
  getRoster(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.getProjectRoster(u, projectId);
  }

  @Post(":projectId/members")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @ResponseSchema(projectMemberRowSchema)
  @Validate({ params: projectIdParams, body: addMemberSchema })
  addMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.addMember(projectId, body, u);
  }

  @Delete(":projectId/members")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdParams, body: removeMemberSchema })
  removeMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: RemoveMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.removeMember(projectId, body.userId, u);
  }

  @Patch(":projectId/members/:memberUserId")
  @RequirePermission("build:manage")
  @ResponseSchema(memberRoleSchema)
  @Validate({ params: projectIdmemberUserIdParams, body: updateProjectMemberRoleSchema })
  updateMemberRole(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("memberUserId") memberUserId: string,
    @Body() body: UpdateProjectMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateMemberRole(projectId, memberUserId, body, u);
  }

  @Put(":projectId/custom-states")
  @RequirePermission("build:manage")
  @ResponseSchema(bulkReorderStatesResultSchema)
  @Validate({ params: projectIdParams, body: bulkReorderStatesSchema })
  bulkReorderCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: BulkReorderStatesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.bulkReorderCustomStates(u, projectId, body);
  }

  @Get(":projectId/custom-states")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(projectCustomStateSchema))
  @Validate({ params: projectIdParams })
  listCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listCustomStates(u, projectId);
  }

  @Post(":projectId/custom-states")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @ResponseSchema(projectCustomStateSchema)
  @Validate({ params: projectIdParams, body: createStateSchema })
  createCustomState(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createCustomState(u, projectId, body);
  }

  @Patch(":projectId/custom-states/:stateId")
  @RequirePermission("build:manage")
  @ResponseSchema(projectCustomStateSchema)
  @Validate({ params: projectIdstateIdParams, body: updateCustomStateSchema })
  updateCustomState(
    @Param("projectId", ParseIntPipe) _: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @Body() body: UpdateCustomStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateCustomState(u, stateId, body);
  }

  @Delete(":projectId/custom-states/:stateId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdstateIdParams })
  deleteCustomState(
    @Param("projectId", ParseIntPipe) _: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteCustomState(u, stateId);
  }

  /**
   * Labels are an ORG-level entity — `ticket_labels` carries no `project_id` — but this route
   * advertises `:projectId`, so a caller reasonably reads the answer as that project's labels.
   * It used not to bind the parameter at all: any project id, another organisation's or none at
   * all, answered 200 with the caller's own labels. The project is now resolved under the caller's
   * organisation so the address in the url means what it says, and a foreign id answers 404.
   */
  @Get(":projectId/labels")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(ticketLabelSchema))
  @Validate({ params: projectIdParams_ })
  async listProjectLabels(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertProjectAccess(u, projectId);
    return this.members.listLabels(u.orgId);
  }

  @Post(":projectId/labels")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @ResponseSchema(ticketLabelSchema)
  @Validate({ params: projectIdParams_, body: createLabelSchema })
  async createProjectLabel(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertCanManageProject(u, projectId);
    return this.members.createLabel(u.orgId, body);
  }
}
