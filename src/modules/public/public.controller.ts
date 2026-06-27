import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RecruitmentService } from "./recruitment.service";
import { RoadmapService } from "./roadmap.service";
import { KbService } from "./kb.service";
import { CrmService } from "./crm.service";
import { IntakeService } from "./intake.service";
import {
  applySchema,
  intakeSchema,
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
  type IntakeInput,
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
  ) {}

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

  @Post("intake/:projectId")
  @HttpCode(201)
  submitIntake(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(intakeSchema)) body: IntakeInput,
  ) {
    return this.intake.submitIntake(projectId, body);
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
  getRoadmap(
    @Query(new ZodValidationPipe(roadmapQuerySchema)) query: RoadmapQueryInput,
  ) {
    return this.roadmap.getRoadmap(query.org);
  }

  @Post("roadmap/vote")
  @HttpCode(200)
  voteRoadmap(
    @Query(new ZodValidationPipe(roadmapQuerySchema)) query: RoadmapQueryInput,
    @Body(new ZodValidationPipe(roadmapVoteSchema)) body: RoadmapVoteInput,
  ) {
    return this.roadmap.vote(query.org, body);
  }

  @Post("roadmap/feedback")
  @HttpCode(201)
  submitRoadmapFeedback(
    @Query(new ZodValidationPipe(roadmapQuerySchema)) query: RoadmapQueryInput,
    @Body(new ZodValidationPipe(roadmapFeedbackSchema)) body: RoadmapFeedbackInput,
  ) {
    return this.roadmap.submitFeedback(query.org, body);
  }

  @Get("kb")
  listKb(@Query(new ZodValidationPipe(kbListQuerySchema)) query: KbListInput) {
    return this.kb.list(query);
  }

  @Get("kb/:slug")
  getArticle(
    @Param("slug") slug: string,
    @Query(new ZodValidationPipe(orgQuerySchema)) query: OrgQueryInput,
  ) {
    return this.kb.getArticle(slug, query.org);
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
    return this.kb.submitFeedback(slug, query.org, { ...body, visitorId });
  }
}
