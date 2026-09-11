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
import { PublicPricingService } from "./pricing.service";
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
import { resolveClientIp } from "../../common/http/client-ip";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  contactSubmitSchema as contactSubmitResponseSchema,
  waitlistJoinSchema as waitlistJoinResponseSchema,
  applicationStatusSchema,
  jobListSchema,
  jobDetailSchema,
  jobApplicationSchema,
  offerDetailSchema,
  offerRespondSchema as offerRespondResponseSchema,
  bookingLinkSchema,
  externalReferrerRegisterSchema as externalReferrerRegisterResponseSchema,
  referrerPortalSchema,
  externalReferralSubmitSchema as externalReferralSubmitResponseSchema,
  vendorPortalSchema,
  intakeSubmitSchema,
  publicFormSchema,
  publicFormSubmitSchema as publicFormSubmitResponseSchema,
  leadFormSchema,
  leadFormSubmitSchema,
  publicSurveySchema,
  surveySumbitSchema,
  roadmapSchema,
  roadmapVoteSchema as roadmapVoteResponseSchema,
  roadmapFeedbackSchema as roadmapFeedbackResponseSchema,
  orgNameSchema,
  kbListSchema,
  kbArticleSchema,
  kbFeedbackSchema as kbFeedbackResponseSchema,
} from "./dto/public-response.schemas";

const tokenParams = z.object({ token: z.string().min(1) }).strict();
const orgSlugjobIdParams = z.object({ orgSlug: z.string().min(1), jobId: z.coerce.number().int().positive() }).strict();
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const slugParams = z.object({ slug: z.string().min(1) }).strict();
/**
 * PRD-C048 — `GET /public/careers/:orgSlug/jobs` and `GET /public/org/:orgId` were the two
 * public routes still binding a path segment with no pipe and no `@Validate({ params })`.
 * Unauthenticated surfaces are exactly where an unvalidated segment matters most.
 */
const orgSlugParams = z.object({ orgSlug: z.string().min(1).max(128) }).strict();
const orgIdParams = z.object({ orgId: z.string().min(1).max(128) }).strict();


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
    private readonly pricing: PublicPricingService,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  @Post("contact")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:contact")
  @ResponseSchema(contactSubmitResponseSchema)
  @Validate({ body: contactSubmitSchema })
  submitContact(
    @Body() body: ContactSubmitInput,
    @Req() req: Request,
  ) {
    return this.contact.submit(body, resolveClientIp(req));
  }

  @Post("waitlist")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:waitlist")
  @ResponseSchema(waitlistJoinResponseSchema)
  @Validate({ body: waitlistJoinSchema })
  joinWaitlist(
    @Body() body: WaitlistJoinInput,
    @Req() req: Request,
  ) {
    return this.waitlist.join(body, {
      clientIp: resolveClientIp(req),
      userAgent: header(req, "user-agent"),
      referrer: header(req, "referer"),
    });
  }

  @Get("application-status/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:application-status")
  @ResponseSchema(applicationStatusSchema)
  @Validate({ params: tokenParams })
  applicationStatus(@Param("token") token: string) {
    return this.careers.getApplicationStatus(token);
  }

  @Get("careers/:orgSlug/jobs")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:careers-list")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  @ResponseSchema(jobListSchema)
  @Validate({ params: orgSlugParams })
  listOrgJobs(@Param("orgSlug") orgSlug: string) {
    return this.careers.listOrgJobs(orgSlug);
  }

  @Get("careers/:orgSlug/jobs/:jobId")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:careers-job")
  @ResponseSchema(jobDetailSchema)
  @Validate({ params: orgSlugjobIdParams })
  getOrgJob(
    @Param("orgSlug") orgSlug: string,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.careers.getOrgJob(orgSlug, jobId);
  }

  @Post("careers/:orgSlug/jobs/:jobId/apply")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:job-apply")
  @ResponseSchema(jobApplicationSchema)
  @Validate({ params: orgSlugjobIdParams, body: applySchema })
  applyToOrgJob(
    @Param("orgSlug") orgSlug: string,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body() body: ApplyInput,
  ) {
    return this.careers.applyToOrgJob(orgSlug, jobId, body);
  }

  @Get("offer/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:offer")
  @ResponseSchema(offerDetailSchema)
  @Validate({ params: tokenParams })
  getOffer(@Param("token") token: string) {
    return this.offers.getOffer(token);
  }

  @Patch("offer/:token/respond")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:offer-respond")
  @ResponseSchema(offerRespondResponseSchema)
  @Validate({ params: tokenParams, body: offerRespondSchema })
  respondToOffer(
    @Param("token") token: string,
    @Body() body: OfferRespondInput,
  ) {
    return this.offers.respondToOffer(token, body);
  }

  @Get("interview-booking/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:interview-booking")
  @ResponseSchema(bookingLinkSchema)
  @Validate({ params: tokenParams })
  getBookingLink(@Param("token") token: string) {
    return this.offers.getBookingLink(token);
  }

  @Post("referrals/register")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:referrer-register")
  @ResponseSchema(externalReferrerRegisterResponseSchema)
  @Validate({ body: externalReferrerRegisterSchema })
  registerExternalReferrer(@Body() body: ExternalReferrerRegisterInput) {
    return this.referrers.registerExternalReferrer(body);
  }

  @Get("referrals/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:referrer-portal")
  @ResponseSchema(referrerPortalSchema)
  @Validate({ params: tokenParams })
  getExternalReferrerPortal(@Param("token") token: string) {
    return this.referrers.getExternalReferrerPortal(token);
  }

  @Post("referrals/:token/submit")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:referral-submit")
  @ResponseSchema(externalReferralSubmitResponseSchema)
  @Validate({ params: tokenParams, body: externalReferralSubmitSchema })
  submitExternalReferral(
    @Param("token") token: string,
    @Body() body: ExternalReferralSubmitInput,
    @Req() req: Request,
  ) {
    return this.referrers.submitExternalReferral(token, body, resolveClientIp(req));
  }

  @Get("vendor-portal/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:vendor-portal")
  @ResponseSchema(vendorPortalSchema)
  @Validate({ params: tokenParams })
  getVendorPortal(@Param("token") token: string) {
    return this.referrers.getVendorPortal(token);
  }

  @Post("intake/:projectId")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:intake")
  @ResponseSchema(intakeSubmitSchema)
  @Validate({ params: projectIdParams, body: intakeSchema })
  submitIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: IntakeInput,
  ) {
    return this.intake.submitIntake(projectId, body);
  }

  @Get("forms/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:form-view")
  @ResponseSchema(publicFormSchema)
  @Validate({ params: tokenParams })
  getPublicForm(@Param("token") token: string) {
    return this.publicForms.getFormByToken(token);
  }

  @Post("forms/:token/submit")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:form-submit")
  @ResponseSchema(publicFormSubmitResponseSchema)
  @Validate({ params: tokenParams, body: publicFormSubmitSchema })
  submitPublicForm(
    @Param("token") token: string,
    @Body() body: PublicFormSubmitInput,
  ) {
    return this.publicForms.submitByToken(token, body);
  }

  @Get("lead-form/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:lead-form-view")
  @ResponseSchema(leadFormSchema)
  @Validate({ params: tokenParams })
  getLeadForm(@Param("token") token: string) {
    return this.crm.getLeadForm(token);
  }

  @Post("lead-form/:token")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:lead-form-submit")
  @ResponseSchema(leadFormSubmitSchema)
  @Validate({ params: tokenParams, body: leadFormBodySchema })
  submitLeadForm(
    @Param("token") token: string,
    @Body() body: LeadFormBody,
  ) {
    return this.crm.submitLeadForm(token, body);
  }

  @Get("nps/:token")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:nps-view")
  @ResponseSchema(publicSurveySchema)
  @Validate({ params: tokenParams })
  getSurvey(@Param("token") token: string) {
    return this.crm.getSurvey(token);
  }

  @Post("nps/:token")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:nps-submit")
  @ResponseSchema(surveySumbitSchema)
  @Validate({ params: tokenParams, body: npsSubmitSchema })
  submitSurvey(
    @Param("token") token: string,
    @Body() body: NpsSubmitInput,
  ) {
    return this.crm.submitSurvey(token, body);
  }

  @Get("roadmap")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:roadmap")
  @ResponseSchema(roadmapSchema)
  @Validate({ query: roadmapQuerySchema })
  getRoadmap(@Query() query: RoadmapQueryInput) {
    return runInTenantTransaction(this.db, () => this.roadmap.getRoadmap(query.org), {
      orgId: query.org,
    });
  }

  @Post("roadmap/vote")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:roadmap-vote")
  @ResponseSchema(roadmapVoteResponseSchema)
  @Validate({ query: roadmapQuerySchema, body: roadmapVoteSchema })
  voteRoadmap(
    @Query() query: RoadmapQueryInput,
    @Body() body: RoadmapVoteInput,
    @Req() req: Request,
  ) {
    return runInTenantTransaction(
      this.db,
      () => this.roadmap.vote(query.org, body, resolveClientIp(req)),
      { orgId: query.org },
    );
  }

  @Post("roadmap/feedback")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:roadmap-feedback")
  @ResponseSchema(roadmapFeedbackResponseSchema)
  @Validate({ query: roadmapQuerySchema, body: roadmapFeedbackSchema })
  submitRoadmapFeedback(
    @Query() query: RoadmapQueryInput,
    @Body() body: RoadmapFeedbackInput,
  ) {
    return runInTenantTransaction(this.db, () => this.roadmap.submitFeedback(query.org, body), {
      orgId: query.org,
    });
  }

  @Get("org/:orgId")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:org-info")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  @ResponseSchema(orgNameSchema)
  @Validate({ params: orgIdParams })
  getOrgName(@Param("orgId") orgId: string) {
    return this.org.getOrgName(orgId);
  }

  @Get("kb")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:kb")
  @ResponseSchema(kbListSchema)
  @Validate({ query: kbListQuerySchema })
  listKb(@Query() query: KbListInput) {
    return runInTenantTransaction(this.db, () => this.kb.list(query), { orgId: query.org });
  }

  @Get("kb/:slug")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:kb-article")
  @ResponseSchema(kbArticleSchema)
  @Validate({ params: slugParams, query: orgQuerySchema })
  getArticle(
    @Param("slug") slug: string,
    @Query() query: OrgQueryInput,
  ) {
    return runInTenantTransaction(this.db, () => this.kb.getArticle(slug, query.org), {
      orgId: query.org,
    });
  }

  @Post("kb/:slug/feedback")
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:kb-feedback")
  @ResponseSchema(kbFeedbackResponseSchema)
  @Validate({ params: slugParams, query: orgQuerySchema, body: kbFeedbackSchema })
  submitArticleFeedback(
    @Param("slug") slug: string,
    @Query() query: OrgQueryInput,
    @Body() body: KbFeedbackInput,
    @Req() req: Request,
  ) {
    const visitorId = body.visitorId ?? resolveClientIp(req);
    return runInTenantTransaction(
      this.db,
      () => this.kb.submitFeedback(slug, query.org, { ...body, visitorId }),
      { orgId: query.org },
    );
  }

  /**
   * What the product costs, in the currency the caller asked for.
   *
   * Public because a price that requires a demo is a price the buyer assumes is
   * bad. Reads the same table the charge path reads -- a marketing page with its
   * own copy of the prices eventually quotes a number we do not charge.
   */
  @Get("pricing")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:pricing")
  getPricing(@Query("currency") currency?: string) {
    return this.pricing.pricing(currency);
  }

  /**
   * Where a customer's data would rest.
   *
   * Every European evaluation asks this before anything else, and a compliance
   * review that has to contact us to find out is a review that stalls.
   */
  @Get("data-residency")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:pricing")
  getResidency(@Query("country") country?: string) {
    return this.pricing.residency(country);
  }
}
