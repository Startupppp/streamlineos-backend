import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { AccessService } from "../access/access.service";
import { IssuesService } from "./issues.service";
import { IssueTransitionsService } from "./issue-transitions.service";
import { ISSUES_VIEW_PERMISSION, resolveIssuesViewScope } from "./issue-view-scope";
import {
  createIssueSchema,
  escalateIssueSchema,
  listIssuesQuerySchema,
  listTransitionsQuerySchema,
  transitionIssueSchema,
  updateIssueSchema,
  type CreateIssueInput,
  type EscalateIssueInput,
  type ListIssuesQuery,
  type ListTransitionsQuery,
  type TransitionIssueInput,
  type UpdateIssueInput,
} from "./dto/issues.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  issueDetailSchema,
  issueListResponseSchema,
  issueRecordTypesSchema,
  issueTransitionResultSchema,
  issueTransitionsListSchema,
} from "./dto/issues-response.schemas";
import { z } from "zod";

const issueRecordIdParams = z.object({ issueRecordId: z.string().min(1) }).strict();

const MANAGE = "crm:issues:manage";
const ESCALATE = "crm:issues:escalate";

@RequireModule("crm")
@Controller("crm/issues")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IssuesController {
  constructor(
    private readonly issues: IssuesService,
    private readonly transitions: IssueTransitionsService,
    private readonly access: AccessService,
  ) {}

  @Get("record-types")
  @ResponseSchema(issueRecordTypesSchema)
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  recordTypes() {
    return this.issues.layouts();
  }

  @Get()
  @ResponseSchema(issueListResponseSchema)
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  @Validate({ query: listIssuesQuerySchema })
  async list(
    @Query() query: ListIssuesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveIssuesViewScope(this.access, u);
    return this.issues.list(read, query);
  }

  @Get(":issueRecordId")
  @ResponseSchema(issueDetailSchema)
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  @Validate({ params: issueRecordIdParams })
  async get(
    @Param("issueRecordId") issueRecordId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveIssuesViewScope(this.access, u);
    return this.issues.get(read, issueRecordId);
  }

  @Get(":issueRecordId/transitions")
  @ResponseSchema(issueTransitionsListSchema)
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  @Validate({ params: issueRecordIdParams, query: listTransitionsQuerySchema })
  async listTransitions(
    @Param("issueRecordId") issueRecordId: string,
    @Query() query: ListTransitionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveIssuesViewScope(this.access, u);
    await this.issues.get(read, issueRecordId);
    return this.transitions.list(u.orgId, issueRecordId, query.limit);
  }

  @Post()
  @ResponseSchema(issueDetailSchema)
  @Idempotent("crm.issues.create")
  @RequirePermission(MANAGE)
  @Validate({ body: createIssueSchema })
  create(
    @Body() body: CreateIssueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.issues.create(u.orgId, u.userId, body);
  }

  @Patch(":issueRecordId")
  @ResponseSchema(issueDetailSchema)
  @RequirePermission(MANAGE)
  @Validate({ params: issueRecordIdParams, body: updateIssueSchema })
  update(
    @Param("issueRecordId") issueRecordId: string,
    @Body() body: UpdateIssueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.issues.update(u.orgId, issueRecordId, body);
  }

  @Post(":issueRecordId/stage")
  @ResponseSchema(issueTransitionResultSchema)
  @Idempotent("crm.issues.stage")
  @RequirePermission(MANAGE)
  @Validate({ params: issueRecordIdParams, body: transitionIssueSchema })
  transition(
    @Param("issueRecordId") issueRecordId: string,
    @Body() body: TransitionIssueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transitions.transition(
      u.orgId,
      issueRecordId,
      body.toStage,
      { kind: "human", userId: u.userId },
      body.reason ?? null,
    );
  }

  @Post(":issueRecordId/escalate")
  @ResponseSchema(issueTransitionResultSchema)
  @Idempotent("crm.issues.escalate")
  @RequirePermission(ESCALATE)
  @Validate({ params: issueRecordIdParams, body: escalateIssueSchema })
  escalate(
    @Param("issueRecordId") issueRecordId: string,
    @Body() body: EscalateIssueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transitions.escalate(
      u.orgId,
      issueRecordId,
      { kind: "human", userId: u.userId },
      body.reason,
    );
  }
}
