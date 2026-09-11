import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { documentTypes, organizations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { toSlug } from "../../config/hr-config.helpers";
import {
  GLOBAL_DOCUMENTS,
  resolveCountryRequirements,
  type CountryOnboardingRequirements,
} from "./onboarding-requirements.catalog";

@Injectable()
export class OnboardingRequirementsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveCountryCode(
    orgId: string,
    input?: string | null,
  ): Promise<string> {
    if (input && input.trim()) return input.trim().toUpperCase();
    const [org] = await this.db
      .select({ country: organizations.country })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const raw = (org?.country ?? "").trim();
    if (raw.length === 2) return raw.toUpperCase();
    return "IN";
  }

  async getRequirements(
    orgId: string,
    input?: string | null,
  ): Promise<CountryOnboardingRequirements> {
    const code = await this.resolveCountryCode(orgId, input);
    return resolveCountryRequirements(code);
  }

  async ensureDocumentTypes(
    orgId: string,
    input?: string | null,
  ): Promise<{ countryCode: string; seeded: number }> {
    const code = await this.resolveCountryCode(orgId, input);
    const req = resolveCountryRequirements(code);

    const existing = await this.db
      .select({ slug: documentTypes.slug })
      .from(documentTypes)
      .where(eq(documentTypes.orgId, orgId))
      .limit(1_000);
    const existingSlugs = new Set(existing.map((r) => r.slug));

    const inserts: {
      orgId: string;
      name: string;
      slug: string;
      description: string;
      countryCode: string | null;
      isMandatory: boolean;
      sortOrder: number;
      isActive: boolean;
    }[] = [];

    GLOBAL_DOCUMENTS.forEach((doc, i) => {
      const slug = doc.slug || toSlug(doc.name);
      if (existingSlugs.has(slug)) return;
      inserts.push({
        orgId,
        name: doc.name,
        slug,
        description: doc.description,
        countryCode: null,
        isMandatory: doc.isMandatory,
        sortOrder: i,
        isActive: true,
      });
    });

    req.documents.forEach((doc, i) => {
      const slug = doc.slug || toSlug(doc.name);
      if (existingSlugs.has(slug)) return;
      inserts.push({
        orgId,
        name: doc.name,
        slug,
        description: doc.description,
        countryCode: req.countryCode,
        isMandatory: doc.isMandatory,
        sortOrder: 100 + i,
        isActive: true,
      });
    });

    if (inserts.length > 0) {
      await this.db.insert(documentTypes).values(inserts);
    }

    return { countryCode: req.countryCode, seeded: inserts.length };
  }
}
