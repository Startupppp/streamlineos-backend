import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DirectoryService } from "./directory.service";
import {
  createPersonSchema,
  listPeopleQuerySchema,
  updatePersonSchema,
  listWorkersQuerySchema,
  createWorkerSchema,
  createEngagementSchema,
  updateEngagementSchema,
  terminateEngagementSchema,
  type CreatePersonInput,
  type ListPeopleQuery,
  type UpdatePersonInput,
  type ListWorkersQuery,
  type CreateWorkerInput,
  type CreateEngagementInput,
  type UpdateEngagementInput,
  type TerminateEngagementInput,
} from "./dto/directory.schemas";

@Controller("directory")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DirectoryController {
  constructor(private readonly svc: DirectoryService) {}

  @Get("people")
  @RequirePermission("directory:people:view")
  listPeople(
    @Query(new ZodValidationPipe(listPeopleQuerySchema)) query: ListPeopleQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPeople(u.orgId, query);
  }

  @Get("people/:organizationPersonId")
  @RequirePermission("directory:people:view")
  getPerson(
    @Param("organizationPersonId") organizationPersonId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getPerson(u.orgId, organizationPersonId);
  }

  @Post("people")
  @HttpCode(201)
  @RequirePermission("directory:people:create")
  createPerson(
    @Body(new ZodValidationPipe(createPersonSchema)) body: CreatePersonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPerson(u.orgId, u.userId, body);
  }

  @Patch("people/:organizationPersonId")
  @RequirePermission("directory:people:update")
  updatePerson(
    @Param("organizationPersonId") organizationPersonId: string,
    @Body(new ZodValidationPipe(updatePersonSchema)) body: UpdatePersonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePerson(u.orgId, u.userId, organizationPersonId, body);
  }

  @Delete("people/:organizationPersonId")
  @HttpCode(204)
  @RequirePermission("directory:people:delete")
  deletePerson(
    @Param("organizationPersonId") organizationPersonId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeletePerson(u.orgId, u.userId, organizationPersonId);
  }

  @Get("workers")
  @RequirePermission("workforce:workers:view")
  listWorkers(
    @Query(new ZodValidationPipe(listWorkersQuerySchema)) query: ListWorkersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listWorkers(u.orgId, query);
  }

  @Get("workers/:workerId")
  @RequirePermission("workforce:workers:view")
  getWorker(
    @Param("workerId") workerId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getWorker(u.orgId, workerId);
  }

  @Post("workers")
  @HttpCode(201)
  @RequirePermission("workforce:workers:manage")
  createWorker(
    @Body(new ZodValidationPipe(createWorkerSchema)) body: CreateWorkerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createWorker(u.orgId, u.userId, body);
  }

  @Get("workers/:workerId/engagements")
  @RequirePermission("workforce:workers:view")
  listEngagements(
    @Param("workerId") workerId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listEngagements(u.orgId, workerId);
  }

  @Post("workers/:workerId/engagements")
  @HttpCode(201)
  @RequirePermission("workforce:workers:manage")
  createEngagement(
    @Param("workerId") workerId: string,
    @Body(new ZodValidationPipe(createEngagementSchema)) body: CreateEngagementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createEngagement(u.orgId, u.userId, { ...body, workerId });
  }

  @Patch("engagements/:workerEngagementId")
  @RequirePermission("workforce:workers:manage")
  updateEngagement(
    @Param("workerEngagementId") workerEngagementId: string,
    @Body(new ZodValidationPipe(updateEngagementSchema)) body: UpdateEngagementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateEngagement(u.orgId, u.userId, workerEngagementId, body);
  }

  @Post("engagements/:workerEngagementId/cancel")
  @HttpCode(200)
  @RequirePermission("workforce:workers:manage")
  cancelEngagement(
    @Param("workerEngagementId") workerEngagementId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancelEngagement(
      u.orgId,
      u.userId,
      workerEngagementId,
    );
  }

  @Post("engagements/:workerEngagementId/terminate")
  @HttpCode(200)
  @RequirePermission("workforce:workers:terminate")
  terminateEngagement(
    @Param("workerEngagementId") workerEngagementId: string,
    @Body(new ZodValidationPipe(terminateEngagementSchema)) body: TerminateEngagementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.terminateEngagement(u.orgId, u.userId, workerEngagementId, body);
  }
}
