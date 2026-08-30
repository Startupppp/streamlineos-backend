import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { PublicCareersService } from "./public-careers.service";
import { PublicOffersService } from "./public-offers.service";
import { PublicReferrersService } from "./public-referrers.service";
import { RoadmapService } from "./roadmap.service";
import { KbService } from "./kb.service";
import { CrmService } from "./crm.service";
import { IntakeService } from "./intake.service";
import { OrgService } from "./org.service";
import { PublicFormsService } from "./public-forms.service";
import { ContactService } from "./contact.service";
import { WaitlistService } from "./waitlist.service";
import {
  applySchema,
  contactSubmitSchema,
  waitlistJoinSchema,
  externalReferralSubmitSchema,
  externalReferrerRegisterSchema,
  intakeSchema,
  publicFormSubmitSchema,
  kbFeedbackSchema,
  kbListQuerySchema,
  leadFormBodySchema,
  npsSubmitSchema,
  offerRespondSchema,
  orgQuerySchema,
  roadmapFeedbackSchema,
  roadmapQuerySchema,
  roadmapVoteSchema,
  type ApplyInput,
  type ContactSubmitInput,
  type WaitlistJoinInput,
  type ExternalReferralSubmitInput,
  type ExternalReferrerRegisterInput,
  type IntakeInput,
  type PublicFormSubmitInput,
  type KbFeedbackInput,
  type KbListInput,
  type LeadFormBody,
  type NpsSubmitInput,
  type OfferRespondInput,
  type OrgQueryInput,
  type RoadmapFeedbackInput,
  type RoadmapQueryInput,
  type RoadmapVoteInput,
} from "./dto/public.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const tokenParams = z.object({ token: z.string().min(1) }).strict();
const orgSlugjobIdParams = z.object({ orgSlug: z.string().min(1), jobId: z.coerce.number().int().positive() }).strict();
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const slugParams = z.object({ slug: z.string().min(1) }).strict();

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw?.split(",")[0]?.trim() || req.ip;
  return candidate ? candidate.slice(0, 100) : undefined;
}

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value.slice(0, 500) : undefined;
}

@Public()
@Controller("public")
export class PublicController {
  constructor(
    private readonly careers: PublicCareersService,
    private readonly offers: PublicOffersService,
    private readonly referrers: PublicReferrersService,
    private readonly roadmap: RoadmapService,
    private readonly kb: KbService,
    private readonly crm: CrmService,
    private readonly intake: IntakeService,
    private readonly org: OrgService,
    private readonly publicForms: PublicFormsService,
    private readonly contact: ContactService,
    private readonly waitlist: WaitlistService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  @Post("contact")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:contact")
  submitContact(
    @Body(new ZodValidationPipe(contactSubmitSchema)) body: ContactSubmitInput,
    @Req() req: Request,
  ) {
    return this.contact.submit(body, clientIp(req));
  }

  @Post("waitlist")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:waitlist")
  joinWaitlist(
    @Body(new ZodValidationPipe(waitlistJoinSchema)) body: WaitlistJoinInput,
    @Req() req: Request,
  ) {
    return this.waitlist.join(body, {
      clientIp: clientIp(req),
      userAgent: header(req, "user-agent"),
      referrer: header(req, "referer"),
    });
  }

  @Get("application-status/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:application-status")
  @Validate({ params: tokenParams })
  applicationStatus(@Param("token") token: string) {
    return this.careers.getApplicationStatus(token);
  }

  @Get("careers/:orgSlug/jobs")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  listOrgJobs(@Param("orgSlug") orgSlug: string) {
    return this.careers.listOrgJobs(orgSlug);
  }

  @Get("careers/:orgSlug/jobs/:jobId")
  @Validate({ params: orgSlugjobIdParams })
  getOrgJob(
    @Param("orgSlug") orgSlug: string,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.careers.getOrgJob(orgSlug, jobId);
  }

  @Post("careers/:orgSlug/jobs/:jobId/apply")
  @HttpCode(201)
  @Validate({ params: orgSlugjobIdParams })
  applyToOrgJob(
    @Param("orgSlug") orgSlug: string,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(applySchema)) body: ApplyInput,
  ) {
    return this.careers.applyToOrgJob(orgSlug, jobId, body);
  }

  @Get("offer/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:offer")
  @Validate({ params: tokenParams })
  getOffer(@Param("token") token: string) {
    return this.offers.getOffer(token);
  }

  @Patch("offer/:token/respond")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:offer-respond")
  @Validate({ params: tokenParams })
  respondToOffer(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(offerRespondSchema)) body: OfferRespondInput,
  ) {
    return this.offers.respondToOffer(token, body);
  }

  @Get("interview-booking/:token")
  @Validate({ params: tokenParams })
  getBookingLink(@Param("token") token: string) {
    return this.offers.getBookingLink(token);
  }

  @Post("referrals/register")
  @HttpCode(201)
  registerExternalReferrer(
    @Body(new ZodValidationPipe(externalReferrerRegisterSchema)) body: ExternalReferrerRegisterInput,
  ) {
    return this.referrers.registerExternalReferrer(body);
  }

  @Get("referrals/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:referrer-portal")
  @Validate({ params: tokenParams })
  getExternalReferrerPortal(@Param("token") token: string) {
    return this.referrers.getExternalReferrerPortal(token);
  }

  @Post("referrals/:token/submit")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:referral-submit")
  @Validate({ params: tokenParams })
  submitExternalReferral(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(externalReferralSubmitSchema)) body: ExternalReferralSubmitInput,
    @Req() req: Request,
  ) {
    return this.referrers.submitExternalReferral(token, body, clientIp(req));
  }

  @Get("vendor-portal/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:vendor-portal")
  @Validate({ params: tokenParams })
  getVendorPortal(@Param("token") token: string) {
    return this.referrers.getVendorPortal(token);
  }

  @Post("intake/:projectId")
  @HttpCode(201)
  @Validate({ params: projectIdParams })
  submitIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(intakeSchema)) body: IntakeInput,
  ) {
    return this.intake.submitIntake(projectId, body);
  }

  @Get("forms/:token")
  @Validate({ params: tokenParams })
  getPublicForm(@Param("token") token: string) {
    return this.publicForms.getFormByToken(token);
  }

  @Post("forms/:token/submit")
  @HttpCode(201)
  @Validate({ params: tokenParams })
  submitPublicForm(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(publicFormSubmitSchema)) body: PublicFormSubmitInput,
  ) {
    return this.publicForms.submitByToken(token, body);
  }

  @Get("lead-form/:token")
  @Validate({ params: tokenParams })
  getLeadForm(@Param("token") token: string) {
    return this.crm.getLeadForm(token);
  }

  @Post("lead-form/:token")
  @HttpCode(200)
  @Validate({ params: tokenParams })
  submitLeadForm(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(leadFormBodySchema)) body: LeadFormBody,
  ) {
    return this.crm.submitLeadForm(token, body);
  }

  @Get("nps/:token")
  @Validate({ params: tokenParams })
  getSurvey(@Param("token") token: string) {
    return this.crm.getSurvey(token);
  }

  @Post("nps/:token")
  @HttpCode(200)
  @Validate({ params: tokenParams })
  submitSurvey(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(npsSubmitSchema)) body: NpsSubmitInput,
  ) {
    return this.crm.submitSurvey(token, body);
  }

  @Get("roadmap")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:roadmap")
  getRoadmap(
    @Query(new ZodValidationPipe(roadmapQuerySchema)) query: RoadmapQueryInput,
  ) {
    return runInTenantTransaction(this.db, () => this.roadmap.getRoadmap(query.org), {
      orgId: query.org,
    });
  }

  @Post("roadmap/vote")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:roadmap-vote")
  voteRoadmap(
    @Query(new ZodValidationPipe(roadmapQuerySchema)) query: RoadmapQueryInput,
    @Body(new ZodValidationPipe(roadmapVoteSchema)) body: RoadmapVoteInput,
    @Req() req: Request,
  ) {
    return runInTenantTransaction(
      this.db,
      () => this.roadmap.vote(query.org, body, clientIp(req)),
      { orgId: query.org },
    );
  }

  @Post("roadmap/feedback")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:roadmap-feedback")
  submitRoadmapFeedback(
    @Query(new ZodValidationPipe(roadmapQuerySchema)) query: RoadmapQueryInput,
    @Body(new ZodValidationPipe(roadmapFeedbackSchema)) body: RoadmapFeedbackInput,
  ) {
    return runInTenantTransaction(this.db, () => this.roadmap.submitFeedback(query.org, body), {
      orgId: query.org,
    });
  }

  @Get("org/:orgId")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  getOrgName(@Param("orgId") orgId: string) {
    return this.org.getOrgName(orgId);
  }

  @Get("kb")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:kb")
  listKb(@Query(new ZodValidationPipe(kbListQuerySchema)) query: KbListInput) {
    return runInTenantTransaction(this.db, () => this.kb.list(query), { orgId: query.org });
  }

  @Get("kb/:slug")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:kb-article")
  @Validate({ params: slugParams })
  getArticle(
    @Param("slug") slug: string,
    @Query(new ZodValidationPipe(orgQuerySchema)) query: OrgQueryInput,
  ) {
    return runInTenantTransaction(this.db, () => this.kb.getArticle(slug, query.org), {
      orgId: query.org,
    });
  }

  @Post("kb/:slug/feedback")
  @HttpCode(201)
  @Validate({ params: slugParams })
  submitArticleFeedback(
    @Param("slug") slug: string,
    @Query(new ZodValidationPipe(orgQuerySchema)) query: OrgQueryInput,
    @Body(new ZodValidationPipe(kbFeedbackSchema)) body: KbFeedbackInput,
    @Req() req: Request,
  ) {
    const visitorId = body.visitorId ?? clientIp(req);
    return runInTenantTransaction(
      this.db,
      () => this.kb.submitFeedback(slug, query.org, { ...body, visitorId }),
      { orgId: query.org },
    );
  }
}
