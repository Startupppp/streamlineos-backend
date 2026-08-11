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
import { RecruitmentService } from "./recruitment.service";
import { RoadmapService } from "./roadmap.service";
import { KbService } from "./kb.service";
import { CrmService } from "./crm.service";
import { IntakeService } from "./intake.service";
import { OrgService } from "./org.service";
import { PublicFormsService } from "./public-forms.service";
import { ContactService } from "./contact.service";
import {
  applySchema,
  contactSubmitSchema,
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

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw?.split(",")[0]?.trim() || req.ip;
  return candidate ? candidate.slice(0, 100) : undefined;
}

@Public()
@Controller("public")
export class PublicController {
  constructor(
    private readonly recruitment: RecruitmentService,
    private readonly roadmap: RoadmapService,
    private readonly kb: KbService,
    private readonly crm: CrmService,
    private readonly intake: IntakeService,
    private readonly org: OrgService,
    private readonly publicForms: PublicFormsService,
    private readonly contact: ContactService,
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

  @Get("application-status/:token")
  applicationStatus(@Param("token") token: string) {
    return this.recruitment.getApplicationStatus(token);
  }

  @Get("careers/:orgSlug/jobs")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  listOrgJobs(@Param("orgSlug") orgSlug: string) {
    return this.recruitment.listOrgJobs(orgSlug);
  }

  @Get("careers/:orgSlug/jobs/:jobId")
  getOrgJob(
    @Param("orgSlug") orgSlug: string,
    @Param("jobId", ParseIntPipe) jobId: number,
  ) {
    return this.recruitment.getOrgJob(orgSlug, jobId);
  }

  @Post("careers/:orgSlug/jobs/:jobId/apply")
  @HttpCode(201)
  applyToOrgJob(
    @Param("orgSlug") orgSlug: string,
    @Param("jobId", ParseIntPipe) jobId: number,
    @Body(new ZodValidationPipe(applySchema)) body: ApplyInput,
  ) {
    return this.recruitment.applyToOrgJob(orgSlug, jobId, body);
  }

  @Get("offer/:token")
  getOffer(@Param("token") token: string) {
    return this.recruitment.getOffer(token);
  }

  @Patch("offer/:token/respond")
  respondToOffer(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(offerRespondSchema)) body: OfferRespondInput,
  ) {
    return this.recruitment.respondToOffer(token, body);
  }

  @Get("interview-booking/:token")
  getBookingLink(@Param("token") token: string) {
    return this.recruitment.getBookingLink(token);
  }

  @Post("referrals/register")
  @HttpCode(201)
  registerExternalReferrer(
    @Body(new ZodValidationPipe(externalReferrerRegisterSchema)) body: ExternalReferrerRegisterInput,
  ) {
    return this.recruitment.registerExternalReferrer(body);
  }

  @Get("referrals/:token")
  getExternalReferrerPortal(@Param("token") token: string) {
    return this.recruitment.getExternalReferrerPortal(token);
  }

  @Post("referrals/:token/submit")
  @HttpCode(201)
  submitExternalReferral(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(externalReferralSubmitSchema)) body: ExternalReferralSubmitInput,
    @Req() req: Request,
  ) {
    return this.recruitment.submitExternalReferral(token, body, clientIp(req));
  }

  @Get("vendor-portal/:token")
  getVendorPortal(@Param("token") token: string) {
    return this.recruitment.getVendorPortal(token);
  }

  @Post("intake/:projectId")
  @HttpCode(201)
  submitIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(intakeSchema)) body: IntakeInput,
  ) {
    return this.intake.submitIntake(projectId, body);
  }

  @Get("forms/:token")
  getPublicForm(@Param("token") token: string) {
    return this.publicForms.getFormByToken(token);
  }

  @Post("forms/:token/submit")
  @HttpCode(201)
  submitPublicForm(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(publicFormSubmitSchema)) body: PublicFormSubmitInput,
  ) {
    return this.publicForms.submitByToken(token, body);
  }

  @Get("lead-form/:token")
  getLeadForm(@Param("token") token: string) {
    return this.crm.getLeadForm(token);
  }

  @Post("lead-form/:token")
  @HttpCode(200)
  submitLeadForm(
    @Param("token") token: string,
    @Body(new ZodValidationPipe(leadFormBodySchema)) body: LeadFormBody,
  ) {
    return this.crm.submitLeadForm(token, body);
  }

  @Get("nps/:token")
  getSurvey(@Param("token") token: string) {
    return this.crm.getSurvey(token);
  }

  @Post("nps/:token")
  @HttpCode(200)
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
  listKb(@Query(new ZodValidationPipe(kbListQuerySchema)) query: KbListInput) {
    return runInTenantTransaction(this.db, () => this.kb.list(query), { orgId: query.org });
  }

  @Get("kb/:slug")
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
