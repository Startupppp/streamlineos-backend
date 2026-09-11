import { Body, Controller, Get, HttpCode, HttpException, Param, ParseIntPipe, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignPublicService } from "./sign-public.service";
import {
  publicAuthSchema,
  publicConsentSchema,
  publicFieldValueSchema,
  adoptSignatureSchema,
  declineSchema,
  type PublicAuthInput,
  type PublicConsentInput,
  type PublicFieldValueInput,
  type AdoptSignatureInput,
  type DeclineInput,
} from "./dto/e-sign.schemas";

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip || "anon").slice(0, 100);
}

@Public()
@Controller("public/sign")
export class SignPublicController {
  constructor(
    private readonly publicSigning: SignPublicService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async guard(tier: string, token: string, req: Request): Promise<void> {
    const result = await this.rateLimit.check(tier, `${token}:${clientIp(req)}`);
    if (!result.allowed) throw new HttpException({ message: "Too many requests. Please try again shortly." }, 429);
  }

  @Get(":token/session")
  async getSession(@Param("token") token: string, @Req() req: Request) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.getSession(token, { ipAddress: clientIp(req), userAgent: req.headers["user-agent"] });
  }

  @Get(":token/documents/:documentId/preview")
  async getDocumentPreview(@Param("token") token: string, @Param("documentId", ParseIntPipe) documentId: number, @Req() req: Request) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.getDocumentPreview(token, documentId);
  }

  @Post(":token/request-otp")
  @HttpCode(200)
  async requestOtp(@Param("token") token: string, @Req() req: Request) {
    await this.guard("sign:public-otp-request", token, req);
    return this.publicSigning.requestOtp(token);
  }

  @Post(":token/auth")
  @HttpCode(200)
  async authenticate(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(publicAuthSchema)) body: PublicAuthInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-auth", token, req);
    return this.publicSigning.authenticate(token, body, { ipAddress: clientIp(req), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/consent")
  @HttpCode(200)
  async consent(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(publicConsentSchema)) body: PublicConsentInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.acceptConsent(token, body, { ipAddress: clientIp(req), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/fields/:fieldId")
  @HttpCode(200)
  async setFieldValue(
    @Param("token") token: string,
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body(new ZodValidationPipe(publicFieldValueSchema)) body: PublicFieldValueInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.setFieldValue(token, fieldId, body);
  }

  @Post(":token/adopt-signature")
  @HttpCode(200)
  async adoptSignature(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(adoptSignatureSchema)) body: AdoptSignatureInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.adoptSignature(token, body, { ipAddress: clientIp(req), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/complete")
  @HttpCode(200)
  async complete(@Param("token") token: string, @Req() req: Request) {
    await this.guard("sign:public-complete", token, req);
    return this.publicSigning.complete(token, { ipAddress: clientIp(req), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/decline")
  @HttpCode(200)
  async decline(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(declineSchema)) body: DeclineInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-complete", token, req);
    return this.publicSigning.decline(token, body, { ipAddress: clientIp(req), userAgent: req.headers["user-agent"] });
  }
}
