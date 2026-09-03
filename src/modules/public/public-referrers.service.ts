import {
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  candidates,
  externalReferrals,
  externalReferrers,
  jobPostings,
  organizations,
  recruitmentVendors,
  vendorCandidateSubmissions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { randomBytes } from "node:crypto";
import type {
  ExternalReferralSubmitInput,
  ExternalReferrerRegisterInput,
} from "./dto/public.schemas";

@Injectable()
export class PublicReferrersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async registerExternalReferrer(input: ExternalReferrerRegisterInput) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, input.orgId),
      columns: { id: true, name: true },
    });
    if (!org) throw new NotFoundException("Organization not found.");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const normalizedEmail = input.email.toLowerCase().trim();

        const existing = await tx.query.externalReferrers.findFirst({
          where: and(
            eq(externalReferrers.orgId, org.id),
            eq(externalReferrers.email, normalizedEmail),
          ),
        });
        if (existing) {
          if (existing.status === "BLOCKED") {
            throw new ForbiddenException("This referrer account is not eligible to submit referrals.");
          }
          return { referralToken: existing.referralToken, name: existing.name, orgName: org.name };
        }

        const referralToken = randomBytes(16).toString("hex");
        const [created] = await tx
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
      },
      { orgId: org.id },
    );
  }

  async getExternalReferrerPortal(token: string) {
    const referrer = await withPublicToken(this.db, token, (tx) =>
      tx.query.externalReferrers.findFirst({
        where: eq(externalReferrers.referralToken, token),
      }),
    );
    if (!referrer) throw new NotFoundException("Referral link not found.");
    if (referrer.status === "BLOCKED") {
      throw new ForbiddenException("This referrer account is not eligible to submit referrals.");
    }

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const org = await tx.query.organizations.findFirst({
          where: eq(organizations.id, referrer.orgId),
          columns: { name: true, currency: true },
        });

        const openJobs = await tx.query.jobPostings.findMany({
          where: and(eq(jobPostings.orgId, referrer.orgId), eq(jobPostings.status, "OPEN")),
          columns: { id: true, title: true, location: true },
          orderBy: (t, { desc: d }) => [d(t.createdAt)],
        });

        const referrals = await tx.query.externalReferrals.findMany({
          where: eq(externalReferrals.referrerId, referrer.id),
          with: {
            candidate: { columns: { firstName: true, lastName: true } },
            jobPosting: { columns: { title: true } },
          },
          orderBy: (t, { desc: d }) => [d(t.createdAt)],
        });

        return {
          referrerName: referrer.name,
          orgName: org?.name ?? "StreamlineOS",
          currency: org?.currency ?? "INR",
          openJobs,
          referrals: referrals.map((r) => ({
            id: r.id,
            candidateName: r.candidate
              ? `${r.candidate.firstName} ${r.candidate.lastName}`
              : "Candidate",
            jobTitle: r.jobPosting?.title ?? null,
            status: r.status,
            rewardAmount: r.rewardAmount,
            createdAt: r.createdAt,
          })),
        };
      },
      { orgId: referrer.orgId },
    );
  }

  async submitExternalReferral(
    token: string,
    input: ExternalReferralSubmitInput,
    ipAddress?: string,
  ) {
    const referrer = await withPublicToken(this.db, token, (tx) =>
      tx.query.externalReferrers.findFirst({
        where: eq(externalReferrers.referralToken, token),
      }),
    );
    if (!referrer) throw new NotFoundException("Referral link not found.");
    if (referrer.status === "BLOCKED") {
      throw new ForbiddenException("This referrer account is not eligible to submit referrals.");
    }

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const normalizedEmail = input.email.toLowerCase().trim();

        if (input.jobPostingId) {
          const job = await tx.query.jobPostings.findFirst({
            where: eq(jobPostings.id, input.jobPostingId),
            columns: { orgId: true },
          });
          if (!job || job.orgId !== referrer.orgId) throw new NotFoundException("Job posting not found.");
        }

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
          columns: { id: true },
          where: and(
            eq(externalReferrals.referrerId, referrer.id),
            eq(externalReferrals.candidateId, candidateId),
          ),
        });
        if (existingReferral) return { alreadyReferred: true as const };

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
      },
      { orgId: referrer.orgId },
    );
  }

  async getVendorPortal(token: string) {
    const vendor = await withPublicToken(this.db, token, (tx) =>
      tx.query.recruitmentVendors.findFirst({
        where: eq(recruitmentVendors.portalToken, token),
      }),
    );
    if (!vendor) throw new NotFoundException("Vendor portal link not found.");
    if (!vendor.portalTokenExpiresAt || new Date() > vendor.portalTokenExpiresAt) {
      throw new GoneException(
        "This portal link has expired. Ask your recruiting contact to generate a new one.",
      );
    }

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const submissions = await tx
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
      },
      { orgId: vendor.orgId },
    );
  }
}
