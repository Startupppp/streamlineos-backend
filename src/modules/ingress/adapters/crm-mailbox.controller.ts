import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, RawBodyRequest, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../../common/auth/public.decorator";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmMailboxService } from "./crm-mailbox.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const crmMailboxSyncIdParams = z.object({ crmMailboxSyncId: z.string().min(1) }).strict();

const enableMailboxSchema = z
  .object({ connectionId: z.number().int().positive() })
  .strict();

type EnableMailboxInput = z.infer<typeof enableMailboxSchema>;

@Controller("crm/mailboxes")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmMailboxController {
  constructor(private readonly mailboxes: CrmMailboxService) {}

  @Post("push")
  @BodylessAction()
  @Public()
  @HttpCode(204)
  async push(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-mailbox-signature") signature: string | undefined,
  ): Promise<void> {
    const raw = req.rawBody?.toString("utf8") ?? "";
    await this.mailboxes.push(raw, signature);
  }

  @Get()
  @RequirePermission("crm:ingress:submit")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.mailboxes.list(u.orgId);
  }

  @Post()
  @Idempotent("crm.mailbox.enable")
  @RequirePermission("crm:ingress:submit")
  @Validate({ body: enableMailboxSchema })
  enable(
    @Body() body: EnableMailboxInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailboxes.enable(u.orgId, u.userId, body.connectionId);
  }

  @Delete(":crmMailboxSyncId")
  @RequirePermission("crm:ingress:submit")
  @Validate({ params: crmMailboxSyncIdParams })
  disable(
    @Param("crmMailboxSyncId") crmMailboxSyncId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailboxes.disable(u.orgId, crmMailboxSyncId);
  }

  @Post(":crmMailboxSyncId/sync")
  @BodylessAction()
  @RequirePermission("crm:ingress:submit")
  @Validate({ params: crmMailboxSyncIdParams })
  sync(
    @Param("crmMailboxSyncId") crmMailboxSyncId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailboxes.sync(u.orgId, crmMailboxSyncId);
  }

  @Post("sync")
  @BodylessAction()
  @RequirePermission("crm:ingress:submit")
  sweepAll(@CurrentUser() u: CurrentUserContext) {
    return this.mailboxes.sweepAll(u.orgId);
  }
}
