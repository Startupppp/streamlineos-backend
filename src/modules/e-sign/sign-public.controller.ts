import { Body, Controller, Get, HttpCode, HttpException, Param, ParseIntPipe, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { Validate } from "../../common/validation/validate.decorator";
import { SignPublicService } from "./sign-public.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import {
  publicAuthSchema,
  publicConsentSchema,
  publicFieldValueSchema,
  adoptSignatureSchema,
  declineSchema,
  publicFormSubmitSchema,
  type PublicAuthInput,
  type PublicConsentInput,
  type PublicFieldValueInput,
  type AdoptSignatureInput,
  type DeclineInput,
  type PublicFormESignSubmitInput,
} from "./dto/e-sign.schemas";
import { resolveClientIpOr } from "../../common/http/client-ip";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  getSessionResponseSchema,
  previewDocumentResponseSchema,
  requestOtpResponseSchema,
  authenticateResponseSchema,
  consentResponseSchema,
  setFieldValueResponseSchema,
  adoptSignatureResponseSchema,
  completeSigningResponseSchema,
  declineSigningResponseSchema,
  getPublicFormResponseSchema,
  submitPublicFormResponseSchema,
} from "./dto/e-sign-response.schemas";


const tokenParams = z.object({ token: z.string().min(1) }).strict();
const slugParams = z.object({ slug: z.string().min(1) }).strict();
const tokenAndDocumentIdParams = z.object({ token: z.string().min(1), documentId: z.coerce.number().int().positive() }).strict();
const tokenAndFieldIdParams = z.object({ token: z.string().min(1), fieldId: z.coerce.number().int().positive() }).strict();

@Public()
@Controller("public/sign")
export class SignPublicController {
  constructor(
    private readonly publicSigning: SignPublicService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async guard(tier: string, token: string, req: Request): Promise<void> {
    const result = await this.rateLimit.check(tier, `${token}:${resolveClientIpOr(req, "anon")}`);
    if (!result.allowed) throw new HttpException({ message: "Too many requests. Please try again shortly." }, 429);
  }

  @Get(":token/session")
  @ResponseSchema(getSessionResponseSchema)
  @Validate({ params: tokenParams })
  async getSession(@Param("token") token: string, @Req() req: Request) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.getSession(token, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }

  @Get(":token/documents/:documentId/preview")
  @ResponseSchema(previewDocumentResponseSchema)
  @Validate({ params: tokenAndDocumentIdParams })
  async getDocumentPreview(@Param("token") token: string, @Param("documentId", ParseIntPipe) documentId: number, @Req() req: Request) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.getDocumentPreview(token, documentId);
  }

  @Post(":token/request-otp")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(requestOtpResponseSchema)
  @Validate({ params: tokenParams })
  async requestOtp(@Param("token") token: string, @Req() req: Request) {
    await this.guard("sign:public-otp-request", token, req);
    return this.publicSigning.requestOtp(token);
  }

  @Post(":token/auth")
  @HttpCode(200)
  @ResponseSchema(authenticateResponseSchema)
  @Validate({ params: tokenParams, body: publicAuthSchema })
  async authenticate(
    @Param("token") token: string,
    @Body() body: PublicAuthInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-auth", token, req);
    return this.publicSigning.authenticate(token, body, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/consent")
  @HttpCode(200)
  @ResponseSchema(consentResponseSchema)
  @Validate({ params: tokenParams, body: publicConsentSchema })
  async consent(
    @Param("token") token: string,
    @Body() body: PublicConsentInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.acceptConsent(token, body, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/fields/:fieldId")
  @HttpCode(200)
  @ResponseSchema(setFieldValueResponseSchema)
  @Validate({ params: tokenAndFieldIdParams, body: publicFieldValueSchema })
  async setFieldValue(
    @Param("token") token: string,
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: PublicFieldValueInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.setFieldValue(token, fieldId, body);
  }

  @Post(":token/adopt-signature")
  @HttpCode(200)
  @ResponseSchema(adoptSignatureResponseSchema)
  @Validate({ params: tokenParams, body: adoptSignatureSchema })
  async adoptSignature(
    @Param("token") token: string,
    @Body() body: AdoptSignatureInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-session", token, req);
    return this.publicSigning.adoptSignature(token, body, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/complete")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(completeSigningResponseSchema)
  @Validate({ params: tokenParams })
  async complete(@Param("token") token: string, @Req() req: Request) {
    await this.guard("sign:public-complete", token, req);
    return this.publicSigning.complete(token, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }

  @Post(":token/decline")
  @HttpCode(200)
  @ResponseSchema(declineSigningResponseSchema)
  @Validate({ params: tokenParams, body: declineSchema })
  async decline(
    @Param("token") token: string,
    @Body() body: DeclineInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-complete", token, req);
    return this.publicSigning.decline(token, body, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }

  @Get("forms/:slug")
  @ResponseSchema(getPublicFormResponseSchema)
  @Validate({ params: slugParams })
  async getPublicForm(@Param("slug") slug: string, @Req() req: Request) {
    await this.guard("sign:public-session", slug, req);
    return this.publicSigning.getPublicForm(slug);
  }

  @Post("forms/:slug/submit")
  @HttpCode(201)
  @ResponseSchema(submitPublicFormResponseSchema)
  @Validate({ params: slugParams, body: publicFormSubmitSchema })
  async submitPublicForm(
    @Param("slug") slug: string,
    @Body() body: PublicFormESignSubmitInput,
    @Req() req: Request,
  ) {
    await this.guard("sign:public-form-submit", slug, req);
    return this.publicSigning.submitPublicForm(slug, body, { ipAddress: resolveClientIpOr(req, "anon"), userAgent: req.headers["user-agent"] });
  }
}
