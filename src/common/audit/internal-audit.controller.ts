import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { Validate } from "../validation/validate.decorator";
import { auditEntrySchema } from "./audit-entry.schema";
import { AuditService, type AuditEntry } from "./audit.service";

@Controller("internal")
export class InternalAuditController {
  constructor(private readonly audit: AuditService) {}

  @Public()
  @Post("audit")
  @HttpCode(201)
  @Validate({ body: auditEntrySchema })
  logAudit(
    @Headers("x-internal-secret") secret: string | undefined,
    @Body() body: AuditEntry,
  ): { ok: true } {
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected || secret !== expected) {
      throw new UnauthorizedException();
    }
    this.audit.log(body);
    return { ok: true };
  }
}
