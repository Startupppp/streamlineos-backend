import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { KnowledgeCollectionService } from "./collection/knowledge-collection.service";
import {
  kbPageCollectionQuerySchema,
  type KbPageCollectionQueryInput,
} from "./dto/kb.schemas";
import { kbPageCollectionPageSchema } from "./dto/kb-core-response.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageCollectionController {
  constructor(private readonly collection: KnowledgeCollectionService) {}

  @Get("pages")
  @RequirePermission("kb:pages:view")
  @Validate({ query: kbPageCollectionQuerySchema })
  @ResponseSchema(kbPageCollectionPageSchema)
  async listPages(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: KbPageCollectionQueryInput,
  ) {
    return this.collection.listPages(u, query);
  }
}
