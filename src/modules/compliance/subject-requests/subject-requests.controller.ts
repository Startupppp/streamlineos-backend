import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { SubjectRequestsService } from "./subject-requests.service";
import {
  executeSubjectRequestSchema,
  listSubjectRequestsQuerySchema,
  type ExecuteSubjectRequestInput,
  type ListSubjectRequestsQuery,
} from "../dto/subject-request.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listSubjectRequestsResponseSchema,
  executeSubjectRequestResponseSchema,
} from "../dto/compliance-response.schemas";

/**
 * Running a data subject's request, and reading the record of one.
 *
 * Authenticated, unlike its neighbour. `SubprocessorsController` is `@Public()`
 * because the register describes us; this describes a named person, and the
 * erasure route deletes their rows across every tenant they appear in.
 *
 * The permission key is the first gate and not the last one. Every organisation
 * owner on the platform is authorised for every catalogued key
 * (`access.service.ts:655`), so the second gate — the declared-operator list in
 * `subject-request-operators.ts` — is what actually keeps a cross-tenant erasure
 * out of the hands of ten thousand tenant owners. Both routes pass through it,
 * inside the service, so no other caller can reach the work without it.
 */
@Controller("compliance/subject-requests")
export class SubjectRequestsController {
  constructor(private readonly subjectRequests: SubjectRequestsService) {}

  /**
   * The record, not the data. Deliberately returns counts and completeness and
   * never the exported rows — see the service's `file`.
   */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("compliance:subject-requests:view")
  @Validate({ query: listSubjectRequestsQuerySchema })
  @ResponseSchema(listSubjectRequestsResponseSchema)
  async list(@Query() query: ListSubjectRequestsQuery) {
    return { data: await this.subjectRequests.list(query.subjectEmail) };
  }

  /**
   * Runs the request across every configured region and files the result.
   *
   * Not `@Idempotent`: a repeated erasure is harmless (the rows are already
   * gone) and each run files its own record, which is the honest history of who
   * asked for what and when.
   */
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("compliance:subject-requests:execute")
  @Validate({ body: executeSubjectRequestSchema })
  @ResponseSchema(executeSubjectRequestResponseSchema)
  async execute(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: ExecuteSubjectRequestInput,
  ) {
    return this.subjectRequests.execute(user.userId, {
      kind: body.kind,
      subjectEmail: body.subjectEmail,
      dueBy: body.dueBy ?? null,
      backupsExpireBy: body.backupsExpireBy ?? null,
    });
  }
}
