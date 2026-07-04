import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  candidateApplications,
  candidateOffers,
  candidates,
  externalReferrals,
  externalReferrers,
  interviewBookingLinks,
  jobPostings,
  organizations,
  recruitmentVendors,
  vendorCandidateSubmissions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  ApplyInput,
  ExternalReferralSubmitInput,
  ExternalReferrerRegisterInput,
  OfferRespondInput,
} from "./dto/public.schemas";

@Injectable()
export class RecruitmentService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getApplicationStatus(token: string) {
    const application = await this.db.query.candidateApplications.findFirst({
      where: eq(candidateApplications.trackingToken, token),
      columns: { status: true, appliedAt: true, updatedAt: true },
      with: {
        candidate: { columns: { firstName: true, lastName: true, email: true } },
        jobPosting: { columns: { title: true, location: true, type: true } },
      },
    });

    if (!application) throw new NotFoundException("Application not found");

    return {
      status: application.status,
      appliedAt: application.appliedAt,
      updatedAt: application.updatedAt,
      job: application.jobPosting,
      candidate: application.candidate,
    };
  }

  async listOrgJobs(orgSlug: string) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true, logo: true, industry: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const jobs = await this.db
      .select({
        id: jobPostings.id,
        title: jobPostings.title,
        location: jobPostings.location,
        type: jobPostings.type,
        experience: jobPostings.experience,
        salaryMin: jobPostings.salaryMin,
        salaryMax: jobPostings.salaryMax,
        openings: jobPostings.openings,
        applicationDeadline: jobPostings.applicationDeadline,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.orgId, org.id), eq(jobPostings.status, "OPEN")))
      .orderBy(desc(jobPostings.createdAt));

    return { org, jobs };
  }

  async getOrgJob(orgSlug: string, jobId: number) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true, logo: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, org.id),
        eq(jobPostings.status, "OPEN"),
      ),
    });
    if (!job) throw new NotFoundException("Job not found");

    return { org, job };
  }

  async applyToOrgJob(orgSlug: string, jobId: number, input: ApplyInput) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, org.id),
        eq(jobPostings.status, "OPEN"),
      ),
      columns: { id: true, title: true },
    });
    if (!job) {
      throw new NotFoundException(
        "Job not found or no longer accepting applications.",
      );
    }

    const nameParts = input.name.split(/\s+/);
    const firstName = nameParts[0] ?? input.name;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "-";
    const trackingToken = randomBytes(32).toString("hex");

    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .insert(candidates)
        .values({
          orgId: org.id,
          firstName,
          lastName,
          email: input.email,
          phone: input.phone ?? null,
          linkedinUrl: input.linkedinUrl ?? null,
          resumeUrl: input.resumeUrl ?? null,
          source: "CAREERS_PAGE",
          status: "NEW",
        })
        .onConflictDoNothing()
        .returning({ id: candidates.id });

      let candidateId: number | undefined = candidate?.id;
      if (!candidateId) {
        const [existing] = await tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(and(eq(candidates.email, input.email), eq(candidates.orgId, org.id)))
          .limit(1);
        candidateId = existing?.id;
      }

      if (!candidateId) {
        throw new InternalServerErrorException("Failed to process application.");
      }

      await tx.insert(candidateApplications).values({
        orgId: org.id,
        candidateId,
        jobPostingId: jobId,
        status: "APPLIED",
        coverLetter: input.coverLetter ?? null,
        trackingToken,
      });

      return { trackingToken };
    });
  }

  async getOffer(token: string) {
    const offer = await this.db.query.candidateOffers.findFirst({
      where: eq(candidateOffers.acceptanceToken, token),
      columns: {
        id: true,
        offerStatus: true,
        offeredSalary: true,
        offeredDesignation: true,
        joiningDate: true,
        validUntil: true,
        notes: true,
        acceptanceTokenExpiresAt: true,
      },
    });

    if (!offer) throw new NotFoundException("Offer not found");

    if (
      offer.acceptanceTokenExpiresAt &&
      new Date(offer.acceptanceTokenExpiresAt) < new Date()
    ) {
      throw new GoneException("This offer link has expired.");
    }

    return offer;
  }

  async respondToOffer(token: string, input: OfferRespondInput) {
    const offer = await this.db.query.candidateOffers.findFirst({
      where: eq(candidateOffers.acceptanceToken, token),
      columns: { id: true, offerStatus: true, acceptanceTokenExpiresAt: true },
    });

    if (!offer) throw new NotFoundException("Offer not found");

    if (
      offer.acceptanceTokenExpiresAt &&
      new Date(offer.acceptanceTokenExpiresAt) < new Date()
    ) {
      throw new GoneException("This offer link has expired.");
    }

    if (offer.offerStatus !== "SENT" && offer.offerStatus !== "VIEWED") {
      throw new ConflictException("This offer can no longer be responded to.");
    }

    const newStatus = input.action === "accept" ? "ACCEPTED" : "DECLINED";

    await this.db
      .update(candidateOffers)
      .set({
        offerStatus: newStatus,
        respondedAt: new Date(),
        notes: input.declineReason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(candidateOffers.id, offer.id));

    return { success: true, status: newStatus };
  }

  async getBookingLink(token: string) {
    const link = await this.db.query.interviewBookingLinks.findFirst({
      where: eq(interviewBookingLinks.token, token),
    });

    if (!link) throw new NotFoundException("Booking link not found.");

    if (link.status !== "pending") {
      throw new GoneException({
        error: "This booking link has already been used.",
        status: link.status,
      });
    }

    if (new Date() > link.expiresAt) {
      throw new GoneException("This booking link has expired.");
    }

    const candidate = await this.db.query.candidates.findFirst({
      where: eq(candidates.id, link.candidateId),
      columns: { firstName: true, lastName: true },
    });

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, link.orgId),
      columns: { name: true },
    });

    return {
      candidateName: candidate
        ? `${candidate.firstName} ${candidate.lastName}`
        : "Candidate",
      orgName: org?.name ?? "StreamlineOS",
      interviewType: link.interviewType,
      durationMinutes: link.durationMinutes,
      availableSlots: link.availableSlots,
      notes: link.notes,
    };
  }

  async registerExternalReferrer(input: ExternalReferrerRegisterInput) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, input.orgId),
      columns: { id: true, name: true },
    });
    if (!org) throw new NotFoundException("Organization not found.");

    const normalizedEmail = input.email.toLowerCase().trim();

    const existing = await this.db.query.externalReferrers.findFirst({
      where: and(eq(externalReferrers.orgId, org.id), eq(externalReferrers.email, normalizedEmail)),
    });
    if (existing) {
      if (existing.status === "BLOCKED") {
        throw new ForbiddenException("This referrer account is not eligible to submit referrals.");
      }
      return { referralToken: existing.referralToken, name: existing.name, orgName: org.name };
    }

    const referralToken = randomBytes(16).toString("hex");
    const [created] = await this.db
      .insert(externalReferrers)
      .values({
        orgId: org.id,
        name: input.name,
        email: normalizedEmail,
        phone: input.phone,
        referralToken,
      })
      .returning();

    return { referralToken: created.referralToken, name: created.name, orgName: org.name };
  }

  async getExternalReferrerPortal(token: string) {
    const referrer = await this.db.query.externalReferrers.findFirst({
      where: eq(externalReferrers.referralToken, token),
    });
    if (!referrer) throw new NotFoundException("Referral link not found.");
    if (referrer.status === "BLOCKED") {
      throw new ForbiddenException("This referrer account is not eligible to submit referrals.");
    }

    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, referrer.orgId),
      columns: { name: true },
    });

    const openJobs = await this.db.query.jobPostings.findMany({
      where: and(eq(jobPostings.orgId, referrer.orgId), eq(jobPostings.status, "OPEN")),
      columns: { id: true, title: true, location: true },
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });

    const referrals = await this.db.query.externalReferrals.findMany({
      where: eq(externalReferrals.referrerId, referrer.id),
      with: { candidate: { columns: { firstName: true, lastName: true } }, jobPosting: { columns: { title: true } } },
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });

    return {
      referrerName: referrer.name,
      orgName: org?.name ?? "StreamlineOS",
      openJobs,
      referrals: referrals.map((r) => ({
        id: r.id,
        candidateName: r.candidate ? `${r.candidate.firstName} ${r.candidate.lastName}` : "Candidate",
        jobTitle: r.jobPosting?.title ?? null,
        status: r.status,
        rewardAmount: r.rewardAmount,
        createdAt: r.createdAt,
      })),
    };
  }

  async submitExternalReferral(token: string, input: ExternalReferralSubmitInput, ipAddress?: string) {
    const referrer = await this.db.query.externalReferrers.findFirst({
      where: eq(externalReferrers.referralToken, token),
    });
    if (!referrer) throw new NotFoundException("Referral link not found.");
    if (referrer.status === "BLOCKED") {
      throw new ForbiddenException("This referrer account is not eligible to submit referrals.");
    }

    const normalizedEmail = input.email.toLowerCase().trim();

    if (input.jobPostingId) {
      const job = await this.db.query.jobPostings.findFirst({
        where: eq(jobPostings.id, input.jobPostingId),
        columns: { orgId: true },
      });
      if (!job || job.orgId !== referrer.orgId) throw new NotFoundException("Job posting not found.");
    }

    const result = await this.db.transaction(async (tx) => {
      const existingCandidate = await tx.query.candidates.findFirst({
        where: and(eq(candidates.orgId, referrer.orgId), eq(candidates.email, normalizedEmail)),
        columns: { id: true },
      });

      const candidateId = existingCandidate
        ? existingCandidate.id
        : (
            await tx
              .insert(candidates)
              .values({
                orgId: referrer.orgId,
                firstName: input.firstName,
                lastName: input.lastName,
                email: normalizedEmail,
                phone: input.phone,
                source: "EXTERNAL_REFERRAL",
              })
              .returning({ id: candidates.id })
          )[0]!.id;

      const existingReferral = await tx.query.externalReferrals.findFirst({
        where: and(eq(externalReferrals.referrerId, referrer.id), eq(externalReferrals.candidateId, candidateId)),
      });
      if (existingReferral) {
        return { alreadyReferred: true as const };
      }

      const isDuplicateInPipeline = !!existingCandidate;

      const [created] = await tx
        .insert(externalReferrals)
        .values({
          orgId: referrer.orgId,
          referrerId: referrer.id,
          candidateId,
          jobPostingId: input.jobPostingId,
          status: isDuplicateInPipeline ? "INELIGIBLE" : "SUBMITTED",
          ipAddress,
        })
        .returning();

      return { alreadyReferred: false as const, referral: created };
    });

    return result;
  }

  async getVendorPortal(token: string) {
    const vendor = await this.db.query.recruitmentVendors.findFirst({
      where: eq(recruitmentVendors.portalToken, token),
    });
    if (!vendor) throw new NotFoundException("Vendor portal link not found.");
    if (!vendor.portalTokenExpiresAt || new Date() > vendor.portalTokenExpiresAt) {
      throw new GoneException("This portal link has expired. Ask your recruiting contact to generate a new one.");
    }

    const submissions = await this.db
      .select({
        id: vendorCandidateSubmissions.id,
        placementStatus: vendorCandidateSubmissions.placementStatus,
        submittedAt: vendorCandidateSubmissions.submittedAt,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
        jobTitle: jobPostings.title,
      })
      .from(vendorCandidateSubmissions)
      .leftJoin(candidates, eq(vendorCandidateSubmissions.candidateId, candidates.id))
      .leftJoin(jobPostings, eq(vendorCandidateSubmissions.jobPostingId, jobPostings.id))
      .where(eq(vendorCandidateSubmissions.vendorId, vendor.id))
      .orderBy(desc(vendorCandidateSubmissions.submittedAt));

    return {
      vendorName: vendor.name,
      submissions: submissions.map((s) => ({
        id: s.id,
        candidateName: `${s.candidateFirstName ?? ""} ${s.candidateLastName ?? ""}`.trim() || "Candidate",
        jobTitle: s.jobTitle,
        placementStatus: s.placementStatus,
        submittedAt: s.submittedAt,
      })),
    };
  }
}
