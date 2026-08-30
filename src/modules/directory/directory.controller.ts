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
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const organizationPersonIdParams = z.object({ organizationPersonId: z.string().min(1) }).strict();
const workerIdParams = z.object({ workerId: z.string().min(1) }).strict();
const workerEngagementIdParams = z.object({ workerEngagementId: z.string().min(1) }).strict();

@Controller("directory")
@UseGuards(JwtAuthGuard)
export class DirectoryController {
  constructor(private readonly svc: DirectoryService) {}

  @Get("people")
  @Universal()
  @Validate({ query: listPeopleQuerySchema })
  listPeople(
    @Query() query: ListPeopleQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPeople(u.orgId, query);
  }

  @Get("people/:organizationPersonId")
  @Universal()
  @Validate({ params: organizationPersonIdParams })
  getPerson(
    @Param("organizationPersonId") organizationPersonId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getPerson(u.orgId, organizationPersonId);
  }

  @Post("people")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:people:create")
  @Validate({ body: createPersonSchema })
  createPerson(
    @Body() body: CreatePersonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPerson(u.orgId, u.userId, body);
  }

  @Patch("people/:organizationPersonId")
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:people:update")
  @Validate({ params: organizationPersonIdParams, body: updatePersonSchema })
  updatePerson(
    @Param("organizationPersonId") organizationPersonId: string,
    @Body() body: UpdatePersonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePerson(u.orgId, u.userId, organizationPersonId, body);
  }

  @Delete("people/:organizationPersonId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:people:delete")
  @Validate({ params: organizationPersonIdParams })
  deletePerson(
    @Param("organizationPersonId") organizationPersonId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeletePerson(u.orgId, u.userId, organizationPersonId);
  }

  @Get("workers")
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:view")
  @Validate({ query: listWorkersQuerySchema })
  listWorkers(
    @Query() query: ListWorkersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listWorkers(u.orgId, query);
  }

  @Get("workers/:workerId")
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:view")
  @Validate({ params: workerIdParams })
  getWorker(
    @Param("workerId") workerId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getWorker(u.orgId, workerId);
  }

  @Post("workers")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:manage")
  @Validate({ body: createWorkerSchema })
  createWorker(
    @Body() body: CreateWorkerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createWorker(u.orgId, u.userId, body);
  }

  @Get("workers/:workerId/engagements")
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:view")
  @Validate({ params: workerIdParams })
  listEngagements(
    @Param("workerId") workerId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listEngagements(u.orgId, workerId);
  }

  @Post("workers/:workerId/engagements")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:manage")
  @Validate({ params: workerIdParams, body: createEngagementSchema })
  createEngagement(
    @Param("workerId") workerId: string,
    @Body() body: CreateEngagementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createEngagement(u.orgId, u.userId, { ...body, workerId });
  }

  @Patch("engagements/:workerEngagementId")
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:manage")
  @Validate({ params: workerEngagementIdParams, body: updateEngagementSchema })
  updateEngagement(
    @Param("workerEngagementId") workerEngagementId: string,
    @Body() body: UpdateEngagementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateEngagement(
      u.orgId,
      u.userId,
      workerEngagementId,
      body,
    );
  }

  @Post("engagements/:workerEngagementId/cancel")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:manage")
  @Validate({ params: workerEngagementIdParams })
  cancelEngagement(
    @Param("workerEngagementId") workerEngagementId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancelEngagement(u.orgId, u.userId, workerEngagementId);
  }

  @Post("engagements/:workerEngagementId/terminate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("directory:workers:terminate")
  @Validate({ params: workerEngagementIdParams, body: terminateEngagementSchema })
  terminateEngagement(
    @Param("workerEngagementId") workerEngagementId: string,
    @Body() body: TerminateEngagementInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.terminateEngagement(
      u.orgId,
      u.userId,
      workerEngagementId,
      body,
    );
  }
}
