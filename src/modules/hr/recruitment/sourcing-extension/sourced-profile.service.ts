import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { and, eq, ilike, or } from "drizzle-orm";
import { candidates } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import {
  candidateSourceFor,
  normaliseProfileUrl,
  sourcingNote,
  splitDisplayName,
  type SourcingPlatform,
} from "./sourced-profile";
import type { SaveSourcedProfileInput } from "./sourced-profile.schemas";

/** What the extension is told happened, so its button can say the truth. */
export type SaveOutcome = "created" | "matched";

export interface SavedProfile {
  candidateId: number;
  outcome: SaveOutcome;
  firstName: string;
  lastName: string;
  email: string | null;
  platform: SourcingPlatform;
  /** Fields that were already filled in and were therefore left alone. */
  keptExisting: string[];
}

export interface ProfileLookup {
  candidateId: number | null;
  firstName: string | null;
  lastName: string | null;
  status: string | null;
}

/**
 * An email `candidates` can store when the page did not show one.
 *
 * `candidates.email` is NOT NULL and is what the rest of recruitment dedupes
 * on, so a sourced profile with no visible address still needs a value. It is
 * built from the normalised profile URL, which makes it stable across two saves
 * of the same person and unique across different ones — and it is under
 * `.invalid`, a TLD reserved by RFC 2606 precisely so that nothing will ever
 * route to it. A placeholder that looked deliverable would eventually be
 * mail-merged into a real send.
 */
function placeholderEmail(normalisedUrl: string): string {
  const slug = normalisedUrl
    .replace(/^https:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 120);
  return `${slug || "profile"}@sourced.invalid`;
}

export function isPlaceholderEmail(email: string): boolean {
  return email.toLowerCase().endsWith("@sourced.invalid");
}

@Injectable()
export class SourcedProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  /**
   * Whether this profile is already in the org, for the extension to show
   * before the recruiter commits to saving.
   *
   * Returns the candidate's name and stage and nothing else. The extension runs
   * on a third-party page where any script sharing the origin can read what it
   * renders, so this deliberately stops short of contact details.
   */
  async lookup(orgId: string, rawProfileUrl: string): Promise<ProfileLookup> {
    const normalised = normaliseProfileUrl(rawProfileUrl);
    if (!normalised) return { candidateId: null, firstName: null, lastName: null, status: null };

    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.orgId, orgId), eq(candidates.sourceUrl, normalised.url)),
      columns: { id: true, firstName: true, lastName: true, status: true },
    });

    if (!existing) return { candidateId: null, firstName: null, lastName: null, status: null };
    return {
      candidateId: existing.id,
      firstName: existing.firstName,
      lastName: existing.lastName,
      status: existing.status,
    };
  }

  async save(
    orgId: string,
    userId: string,
    input: SaveSourcedProfileInput,
  ): Promise<SavedProfile> {
    const normalised = normaliseProfileUrl(input.profileUrl);
    if (!normalised) {
      // The schema already refused this shape; this keeps the type honest.
      throw new InternalServerErrorException("Profile URL failed to normalise.");
    }

    const name = splitDisplayName(input.fullName);
    if (!name) throw new InternalServerErrorException("Name failed to split.");

    /*
      URL first, then email.

      Both are matched in one query and the URL wins when both hit, because a
      profile address identifies an account while an email can be shared — a
      couple's address, an agency's inbox, a `first.last@` collision at a large
      employer. Matching on the weaker key first would occasionally attach one
      person's sourcing history to another's record, and nothing downstream
      would ever show that it had happened.
    */
    const byUrl = eq(candidates.sourceUrl, normalised.url);
    const match = input.email
      ? await this.db.query.candidates.findFirst({
          where: and(eq(candidates.orgId, orgId), or(byUrl, ilike(candidates.email, input.email))),
          columns: { id: true, sourceUrl: true },
          orderBy: (t, { desc }) => [desc(t.sourceUrl)],
        })
      : await this.db.query.candidates.findFirst({
          where: and(eq(candidates.orgId, orgId), byUrl),
          columns: { id: true, sourceUrl: true },
        });

    const note = sourcingNote({
      platform: normalised.platform,
      profileUrl: normalised.url,
      headline: input.headline,
      recruiterNote: input.note,
    });

    const saved = match
      ? await this.enrichExisting(orgId, match.id, normalised.url, input, note)
      : await this.createFromProfile(orgId, normalised.url, normalised.platform, name, input, note);

    await this.cache.invalidateNamespace(`hr:candidates:list:${orgId}`);

    /*
      logCritical, not log. This row is the record that a named recruiter
      asserted consent for holding someone's personal data, which is the
      evidence a DPDP request is answered from. Best-effort telemetry that
      silently drops on failure would leave a candidate in the database with no
      trace of who put them there or on what basis.
    */
    await this.audit.logCritical({
      action:
        saved.outcome === "created"
          ? "hr.recruitment.candidate.sourced"
          : "hr.recruitment.candidate.sourced_matched",
      orgId,
      userId,
      resourceType: "candidate",
      resourceId: String(saved.candidateId),
      metadata: {
        platform: normalised.platform,
        profileUrl: normalised.url,
        consentGiven: true,
        emailCaptured: input.email !== null,
        phoneCaptured: input.phone !== null,
        keptExisting: saved.keptExisting,
      },
    });

    return { ...saved, platform: normalised.platform };
  }

  private async createFromProfile(
    orgId: string,
    profileUrl: string,
    platform: SourcingPlatform,
    name: { firstName: string; lastName: string },
    input: SaveSourcedProfileInput,
    note: string,
  ): Promise<Omit<SavedProfile, "platform">> {
    await this.planLimits.assertWithinLimit(orgId, "hrCandidates");

    const [created] = await this.db
      .insert(candidates)
      .values({
        orgId,
        firstName: name.firstName,
        lastName: name.lastName,
        email: input.email ?? placeholderEmail(profileUrl),
        phone: input.phone,
        linkedinUrl: platform === "linkedin" ? profileUrl : null,
        currentCompany: input.currentCompany,
        currentRole: input.currentRole ?? input.headline,
        location: input.location,
        skills: input.skills.length > 0 ? input.skills : null,
        source: candidateSourceFor(platform),
        sourceUrl: profileUrl,
        status: "NEW",
        notes: note,
      })
      .returning({ id: candidates.id, email: candidates.email });

    if (!created) throw new InternalServerErrorException("Failed to save the sourced profile.");

    return {
      candidateId: created.id,
      outcome: "created",
      firstName: name.firstName,
      lastName: name.lastName,
      email: isPlaceholderEmail(created.email) ? null : created.email,
      keptExisting: [],
    };
  }

  /**
   * Fills the gaps on a candidate the org already has, and only the gaps.
   *
   * A recruiter who corrected a job title by hand, or an applicant who typed
   * their own phone number on the careers page, outranks whatever a listing
   * says today. So every field is written only where the column is currently
   * empty, and the ones that were already filled come back in `keptExisting` so
   * the extension can say what it did not change instead of implying it saved
   * everything on screen.
   */
  private async enrichExisting(
    orgId: string,
    candidateId: number,
    profileUrl: string,
    input: SaveSourcedProfileInput,
    note: string,
  ): Promise<Omit<SavedProfile, "platform">> {
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.orgId, orgId), eq(candidates.id, candidateId)),
      columns: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        currentCompany: true,
        currentRole: true,
        location: true,
        skills: true,
        sourceUrl: true,
        notes: true,
      },
    });
    if (!existing) throw new InternalServerErrorException("Candidate disappeared mid-save.");

    const patch: Record<string, unknown> = {};
    const keptExisting: string[] = [];

    const fill = (field: string, current: string | null, incoming: string | null) => {
      if (incoming === null) return;
      if (current !== null && current !== "") {
        if (current !== incoming) keptExisting.push(field);
        return;
      }
      patch[field] = incoming;
    };

    fill("phone", existing.phone, input.phone);
    fill("currentCompany", existing.currentCompany, input.currentCompany);
    fill("currentRole", existing.currentRole, input.currentRole ?? input.headline);
    fill("location", existing.location, input.location);
    fill("sourceUrl", existing.sourceUrl, profileUrl);

    /*
      A placeholder is not a real address, so an email found on the listing
      replaces one — that is the gap being filled, not an overwrite.
    */
    if (input.email && (existing.email === "" || isPlaceholderEmail(existing.email))) {
      patch.email = input.email;
    } else if (input.email && existing.email.toLowerCase() !== input.email) {
      keptExisting.push("email");
    }

    if (input.skills.length > 0 && (existing.skills === null || existing.skills.length === 0)) {
      patch.skills = input.skills;
    } else if (input.skills.length > 0) {
      keptExisting.push("skills");
    }

    // Notes accumulate. Each save is a separate act of sourcing and the earlier
    // one is the history of how this candidate was found the first time.
    patch.notes = existing.notes ? `${existing.notes}\n\n${note}` : note;

    await this.db
      .update(candidates)
      .set(patch)
      .where(and(eq(candidates.orgId, orgId), eq(candidates.id, candidateId)));

    return {
      candidateId,
      outcome: "matched",
      firstName: existing.firstName,
      lastName: existing.lastName,
      email: isPlaceholderEmail(existing.email) ? null : existing.email,
      keptExisting,
    };
  }
}
