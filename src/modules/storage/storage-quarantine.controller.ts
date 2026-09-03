import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AuditService } from "../../common/audit/audit.service";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { FileQuarantineService } from "./file-quarantine.service";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  quarantineDeleteResponseSchema,
  quarantineListResponseSchema,
  quarantineRecordSchema,
  quarantineStatusResponseSchema,
} from "./dto/storage-response.schemas";
import {
  quarantineListQuerySchema,
  quarantineIdParamSchema,
  quarantineRejectBodySchema,
  type QuarantineListQuery,
  type QuarantineIdParam,
  type QuarantineRejectBody,
} from "./dto/storage-quarantine.schemas";

@Controller("storage/quarantine")
@UseGuards(JwtAuthGuard)
export class StorageQuarantineController {
  constructor(
    private readonly quarantine: FileQuarantineService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ResponseSchema(quarantineListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:quarantine:view")
  @Validate({ query: quarantineListQuerySchema })
  async list(
    @Query() query: QuarantineListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.quarantine.list(u.orgId, {
      limit: query.limit,
      cursor: query.cursor,
      status: query.status,
    });
  }

  @Get(":quarantineId")
  @ResponseSchema(quarantineRecordSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:quarantine:view")
  @Validate({ params: quarantineIdParamSchema })
  async getOne(
    @Param() params: QuarantineIdParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const record = await this.quarantine.findById(u.orgId, params.quarantineId);
    if (!record) throw new NotFoundException("Quarantine record not found");
    return record;
  }

  @Post(":quarantineId/release")
  @ResponseSchema(quarantineStatusResponseSchema)
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:quarantine:manage")
  @Idempotent("storage.quarantine.release")
  @Validate({ params: quarantineIdParamSchema })
  async release(
    @Param() params: QuarantineIdParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const record = await this.quarantine.findById(u.orgId, params.quarantineId);
    if (!record) throw new NotFoundException("Quarantine record not found");
    if (record.status !== "pending_scan")
      throw new ConflictException("Only a pending_scan record can be released");

    await this.quarantine.markClean(record.id);
    this.audit.log({
      action: "file.quarantine.release",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { quarantineId: record.id, storageKey: record.storageKey },
    });
    return { status: "clean" };
  }

  @Post(":quarantineId/reject")
  @ResponseSchema(quarantineStatusResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:quarantine:manage")
  @Idempotent("storage.quarantine.reject")
  @Validate({ params: quarantineIdParamSchema, body: quarantineRejectBodySchema })
  async reject(
    @Param() params: QuarantineIdParam,
    @Body() body: QuarantineRejectBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const record = await this.quarantine.findById(u.orgId, params.quarantineId);
    if (!record) throw new NotFoundException("Quarantine record not found");
    if (record.status === "clean")
      throw new ConflictException("A released file cannot be rejected");

    const threatName = body.reason ?? "manual-rejection";
    await this.quarantine.markInfected(record.id, threatName);
    this.audit.log({
      action: "file.quarantine.reject",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { quarantineId: record.id, storageKey: record.storageKey, threatName },
    });
    return { status: "infected" };
  }

  @Delete(":quarantineId")
  @ResponseSchema(quarantineDeleteResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("storage:quarantine:manage")
  @Validate({ params: quarantineIdParamSchema })
  async remove(
    @Param() params: QuarantineIdParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const record = await this.quarantine.findById(u.orgId, params.quarantineId);
    if (!record) throw new NotFoundException("Quarantine record not found");

    await this.quarantine.softDelete(record.id);
    this.audit.log({
      action: "file.quarantine.delete",
      userId: u.userId,
      orgId: u.orgId,
      metadata: { quarantineId: record.id, storageKey: record.storageKey },
    });
    return { deleted: true };
  }
}
