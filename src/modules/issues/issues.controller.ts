import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

const MANAGE = "crm:issues:manage";
const ESCALATE = "crm:issues:escalate";

/**
 * Issues, tasks and complaints.
 *
 * One controller for three record types, because they are three record types
 * and not three modules. `GET record-types` serves the layout descriptions and
 * every read returns rows keyed to match them, so a surface renders all three
 * through the Phase 1 renderer with no list, table or form written for any of
 * them.
 *
 * Three authorities, deliberately separate. Reading is what makes a failure
 * visible; managing is what changes the record; escalating is what says
 * somebody's handling of it was not good enough. A manager who should see how
 * many complaints are open need not be someone who can raise one over a
 * colleague's head, and folding those into one key would make the second
 * unavoidable to grant.
 */
@RequireModule("crm")
@Controller("crm/issues")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class IssuesController {
  constructor(
    private readonly issues: IssuesService,
    private readonly transitions: IssueTransitionsService,
    private readonly access: AccessService,
  ) {}

  /**
   * The three descriptions.
   *
   * Declared before `:issueRecordId` so the literal path wins the match; a
   * record identifier called "record-types" is not a risk worth a second route
   * prefix, but route order is.
   */
  @Get("record-types")
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  recordTypes() {
    return this.issues.layouts();
  }

  @Get()
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  async list(
    @Query(new ZodValidationPipe(listIssuesQuerySchema)) query: ListIssuesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveIssuesViewScope(this.access, u);
    return this.issues.list(u.orgId, u.userId, query, scope);
  }

  @Get(":issueRecordId")
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  async get(
    @Param("issueRecordId") issueRecordId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveIssuesViewScope(this.access, u);
    return this.issues.get(u.orgId, u.userId, issueRecordId, scope);
  }

  /** One record's history, for a surface that wants it without the record. */
  @Get(":issueRecordId/transitions")
  @RequirePermission(ISSUES_VIEW_PERMISSION)
  async listTransitions(
    @Param("issueRecordId") issueRecordId: string,
    @Query(new ZodValidationPipe(listTransitionsQuerySchema)) query: ListTransitionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveIssuesViewScope(this.access, u);
    // Through the record, so the caller's scope decides whether the history is
    // theirs to read. A ledger route that answered on its own would hand every
    // holder of the view key the escalation history of records they cannot see.
    await this.issues.get(u.orgId, u.userId, issueRecordId, scope);
    return this.transitions.list(u.orgId, issueRecordId, query.limit);
  }

  @Post()
  @Idempotent("crm.issues.create")
  @RequirePermission(MANAGE)
  create(
    @Body(new ZodValidationPipe(createIssueSchema)) body: CreateIssueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.issues.create(u.orgId, u.userId, body);
  }

  @Patch(":issueRecordId")
  @RequirePermission(MANAGE)
  update(
    @Param("issueRecordId") issueRecordId: string,
    @Body(new ZodValidationPipe(updateIssueSchema)) body: UpdateIssueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.issues.update(u.orgId, issueRecordId, body);
  }

  /**
   * An ordinary stage move — acknowledging, resolving, dismissing, reopening.
   *
   * `escalated` is not reachable here: the schema does not accept it, and the
   * route below carries its own key. A stage never moves through the record's
   * own PATCH, so every move leaves a ledger row.
   */
  @Post(":issueRecordId/stage")
  @Idempotent("crm.issues.stage")
  @RequirePermission(MANAGE)
  transition(
    @Param("issueRecordId") issueRecordId: string,
    @Body(new ZodValidationPipe(transitionIssueSchema)) body: TransitionIssueInput,
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

  /**
   * Raise it above its owner.
   *
   * The actor is `human` here because a person is on the other end of the
   * request. The service takes the discriminated actor rather than a user id
   * precisely so the other kind — a sweep, an automation — can write the same
   * ledger without borrowing a person's name.
   */
  @Post(":issueRecordId/escalate")
  @Idempotent("crm.issues.escalate")
  @RequirePermission(ESCALATE)
  escalate(
    @Param("issueRecordId") issueRecordId: string,
    @Body(new ZodValidationPipe(escalateIssueSchema)) body: EscalateIssueInput,
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
