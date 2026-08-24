import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { SubjectService } from "./subject.service";
import {
  createSubjectSchema,
  createSubjectTypeSchema,
  linkPartySchema,
  listSubjectsQuerySchema,
  updateSubjectSchema,
  updateSubjectTypeSchema,
  type CreateSubjectInput,
  type CreateSubjectTypeInput,
  type LinkPartyInput,
  type ListSubjectsQuery,
  type UpdateSubjectInput,
  type UpdateSubjectTypeInput,
} from "./dto/subject.schemas";

/**
 * The thing a tenant transacts.
 *
 * Declaring a type is separated from managing records of it, and carries its own
 * permission: changing a declaration reshapes every record of that type, which
 * is a different act from editing one of them.
 */
@Controller("party")
@UseGuards(JwtAuthGuard)
export class SubjectController {
  constructor(private readonly subjects: SubjectService) {}

  @Get("subject-types")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:view")
  async listTypes(@CurrentUser() user: CurrentUserContext) {
    return { data: await this.subjects.listTypes(user.orgId) };
  }

  @Post("subject-types")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subject-types:manage")
  @Idempotent("party.subject_type.create")
  @Validate({ body: createSubjectTypeSchema })
  async createType(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateSubjectTypeInput,
  ) {
    return this.subjects.createType(user.orgId, user.userId, body);
  }

  @Patch("subject-types/:subjectTypeId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subject-types:manage")
  @Idempotent("party.subject_type.update")
  @Validate({ body: updateSubjectTypeSchema })
  async updateType(
    @CurrentUser() user: CurrentUserContext,
    @Param("subjectTypeId") subjectTypeId: string,
    @Body() body: UpdateSubjectTypeInput,
  ) {
    return this.subjects.updateType(user.orgId, subjectTypeId, user.userId, body);
  }

  @Delete("subject-types/:subjectTypeId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subject-types:manage")
  async deleteType(
    @CurrentUser() user: CurrentUserContext,
    @Param("subjectTypeId") subjectTypeId: string,
  ) {
    await this.subjects.deleteType(user.orgId, subjectTypeId, user.userId);
    return { deleted: true };
  }

  @Get("subjects")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:view")
  @Validate({ query: listSubjectsQuerySchema })
  async list(@CurrentUser() user: CurrentUserContext, @Query() query: ListSubjectsQuery) {
    return this.subjects.listSubjects(user.orgId, query);
  }

  @Get("subjects/:subjectId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:view")
  async get(@CurrentUser() user: CurrentUserContext, @Param("subjectId") subjectId: string) {
    return this.subjects.getSubject(user.orgId, subjectId);
  }

  @Post("subjects")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:manage")
  @Idempotent("party.subject.create")
  @Validate({ body: createSubjectSchema })
  async create(@CurrentUser() user: CurrentUserContext, @Body() body: CreateSubjectInput) {
    return this.subjects.createSubject(user.orgId, user.userId, body);
  }

  @Patch("subjects/:subjectId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:manage")
  @Idempotent("party.subject.update")
  @Validate({ body: updateSubjectSchema })
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("subjectId") subjectId: string,
    @Body() body: UpdateSubjectInput,
  ) {
    return this.subjects.updateSubject(user.orgId, subjectId, user.userId, body);
  }

  @Delete("subjects/:subjectId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:manage")
  @Idempotent("party.subject.delete")
  async remove(@CurrentUser() user: CurrentUserContext, @Param("subjectId") subjectId: string) {
    await this.subjects.deleteSubject(user.orgId, subjectId, user.userId);
    return { deleted: true };
  }

  @Post("subjects/:subjectId/parties")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:manage")
  @Idempotent("party.subject.link")
  @Validate({ body: linkPartySchema })
  async link(
    @CurrentUser() user: CurrentUserContext,
    @Param("subjectId") subjectId: string,
    @Body() body: LinkPartyInput,
  ) {
    return this.subjects.linkParty(user.orgId, subjectId, user.userId, body);
  }

  @Delete("subject-links/:subjectPartyLinkId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:manage")
  async unlink(
    @CurrentUser() user: CurrentUserContext,
    @Param("subjectPartyLinkId") subjectPartyLinkId: string,
  ) {
    await this.subjects.unlinkParty(user.orgId, subjectPartyLinkId, user.userId);
    return { unlinked: true };
  }

  @Get("parties/:partyId/subjects")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:subjects:view")
  async forParty(@CurrentUser() user: CurrentUserContext, @Param("partyId") partyId: string) {
    return { data: await this.subjects.listForParty(user.orgId, partyId) };
  }
}
