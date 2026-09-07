import { z } from "zod";
import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException, UseGuards } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { RateLimitGuard } from "../ratelimit/rate-limit.guard";
import { UseRateLimit } from "../ratelimit/use-rate-limit.decorator";
import { Validate } from "../validation/validate.decorator";
import { ResponseSchema } from "../openapi/zod-operation-contracts";
import { auditEntrySchema } from "./audit-entry.schema";
import { AuditService, type AuditEntry } from "./audit.service";
import { auditLogResponseSchema } from "./dto/audit-response.schemas";

@Controller("internal")
export class InternalAuditController {
  constructor(private readonly audit: AuditService) {}

  @Public()
  @Post("audit")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("internal:audit")
  @Validate({ body: auditEntrySchema })
  @ResponseSchema(auditLogResponseSchema)
  logAudit(
    @Headers("x-internal-secret") secret: string | undefined,
    @Body() body: z.infer<typeof auditEntrySchema>,
  ): { ok: true } {
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected || secret !== expected) {
      throw new UnauthorizedException();
    }
    this.audit.log(body);
    return { ok: true };
  }
}
