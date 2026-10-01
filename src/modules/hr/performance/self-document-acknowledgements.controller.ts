import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead } from "../../access/scoped-read";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ComplianceService } from "./compliance.service";
import {
  acknowledgeComplianceResponseSchema,
  listComplianceResponseSchema,
} from "./dto/documents-response.schemas";

const ackIdParams = z.object({ ackId: z.coerce.number().int().positive() }).strict();

const selfAckSchema = z.object({ status: z.enum(["ACKNOWLEDGED", "DECLINED"]) }).strict();

type SelfAckInput = z.infer<typeof selfAckSchema>;

@Controller("me/document-acknowledgements")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SelfDocumentAcknowledgementsController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  @ResponseSchema(listComplianceResponseSchema)
  @RequirePermission("self:document-acknowledgements")
  list(@CurrentUser() currentUser: CurrentUserContext) {
    return this.compliance.listAcknowledgments(
      ScopedRead.of(currentUser.orgId, currentUser.userId, "own"),
    );
  }

  @Patch(":ackId")
  @ResponseSchema(acknowledgeComplianceResponseSchema)
  @RequirePermission("self:document-acknowledgements")
  @Validate({ params: ackIdParams, body: selfAckSchema })
  acknowledge(
    @Param("ackId", ParseIntPipe) ackId: number,
    @Body() body: SelfAckInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.compliance.acknowledge(currentUser.orgId, currentUser.userId, {
      acknowledgmentId: ackId,
      status: body.status,
    });
  }
}
