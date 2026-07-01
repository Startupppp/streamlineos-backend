import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { SignaturesService } from "./signatures.service";

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard)
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get("signatures/sent")
  listSent(@CurrentUser() u: CurrentUserContext) {
    return this.signatures.listSent(u.orgId, u.userId);
  }

  @Get("signatures/received")
  listReceived(@CurrentUser() u: CurrentUserContext) {
    return this.signatures.listReceived(u.orgId, u.userId);
  }

  @Post("signatures")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:signatures:manage")
  create(
    @Body()
    body: {
      title: string;
      documentType: string;
      documentUrl: string;
      expiresAt?: string;
      signers: { userId: string; order: number; status: string }[];
    },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signatures.create(u.orgId, u.userId, body);
  }

  @Post("signatures/:signatureId/sign")
  @HttpCode(200)
  signDocument(
    @Param("signatureId", ParseIntPipe) signatureId: number,
    @Body() body: { signatureUrl: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signatures.sign(u.orgId, signatureId, u.userId, body.signatureUrl);
  }

  @Patch("signatures/:signatureId/void")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:signatures:manage")
  voidRequest(
    @Param("signatureId", ParseIntPipe) signatureId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signatures.void(u.orgId, signatureId);
  }
}
