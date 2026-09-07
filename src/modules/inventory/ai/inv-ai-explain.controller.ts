import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { InvAiExplainService } from "./inv-ai-explain.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  explainInsightResponseSchema,
  digestResponseSchema,
  reorderProposalResponseSchema,
  confirmReorderProposalResponseSchema,
  supplierDelayBriefingResponseSchema,
} from "./dto/ai-response.schemas";

const insightIdParams = z.object({ insightId: z.coerce.number().int().positive() }).strict();

const reorderProposalBodySchema = z.object({ variantId: z.number().int().positive(), warehouseId: z.number().int().positive().optional() });
const confirmProposalBodySchema = z.object({ proposalId: z.number().int().positive(), token: z.string().min(1) });
const digestQuerySchema = z.object({ narrate: z.enum(["true", "false"]).optional() });
const supplierDelayQuerySchema = z.object({ vendorId: z.coerce.number().int().positive().optional() });
type DigestQueryInput = z.infer<typeof digestQuerySchema>;
type SupplierDelayQueryInput = z.infer<typeof supplierDelayQuerySchema>;

@RequireModule("inventory")
@Controller("inventory/ai")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiExplainController {
  constructor(private readonly explainService: InvAiExplainService) {}

  @Post("insights/:insightId/explain")
  @BodylessAction()
  @ResponseSchema(explainInsightResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  @Validate({ params: insightIdParams })
  explainInsight(
    @Param("insightId", ParseIntPipe) insightId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.explainInsight(u.orgId, u.userId, insightId);
  }

  @Get("digest")
  @ResponseSchema(digestResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  @Validate({ query: digestQuerySchema })
  getDigest(
    @Query() query: DigestQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getDigest(u.orgId, u.userId, query.narrate === "true");
  }

  @Post("reorder-proposal")
  @ResponseSchema(reorderProposalResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  @Validate({ body: reorderProposalBodySchema })
  getReorderProposal(
    @Body() body: z.infer<typeof reorderProposalBodySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getReorderProposal(u.orgId, u.userId, body.variantId, body.warehouseId);
  }

  @Post("reorder-proposal/confirm")
  @ResponseSchema(confirmReorderProposalResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:ai:propose")
  @Validate({ body: confirmProposalBodySchema })
  confirmReorderProposal(
    @Body() body: z.infer<typeof confirmProposalBodySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.confirmReorderProposal(u.orgId, u.userId, body.proposalId, body.token);
  }

  @Get("supplier-delay")
  @ResponseSchema(supplierDelayBriefingResponseSchema)
  @UseGuards(PermissionGuard, RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("inventory:reports:read")
  @Validate({ query: supplierDelayQuerySchema })
  getSupplierDelayBriefing(
    @Query() query: SupplierDelayQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.explainService.getSupplierDelayBriefing(u.orgId, u.userId, query.vendorId);
  }
}
