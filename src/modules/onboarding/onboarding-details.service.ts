import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  documents,
  onboardingSteps,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { encrypt, encryptBankDetails } from "./crypto.helpers";
import { resolveCountryRequirements } from "./onboarding-requirements.catalog";
import type { BankDetailsInput, PersonalDetailsInput } from "./dto/onboarding.schemas";

@Injectable()
export class OnboardingDetailsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async savePersonalDetails(
    orgId: string,
    userId: string,
    input: PersonalDetailsInput,
  ) {
    const emergencyContact =
      input.emergencyName && input.emergencyRelation && input.emergencyPhone
        ? {
            name: input.emergencyName,
            relation: input.emergencyRelation,
            phone: input.emergencyPhone,
          }
        : undefined;

    await this.db
      .update(users)
      .set({
        phone: input.phone,
        ...(input.gender ? { gender: input.gender } : {}),
        ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
        ...(emergencyContact ? { emergencyContact } : {}),
      })
      .where(eq(users.id, userId));

    await this.upsertOnboardingStep(userId, orgId, "Personal Details");

    return { success: true };
  }

  async getPersonalDetails(orgId: string, userId: string) {
    const [user] = await this.db
      .select({
        phone: users.phone,
        gender: users.gender,
        dateOfBirth: users.dateOfBirth,
        emergencyContact: users.emergencyContact,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!user) {
      throw new NotFoundException("User not found in this organization");
    }

    return {
      phone: user.phone,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      emergencyName: user.emergencyContact?.name ?? null,
      emergencyRelation: user.emergencyContact?.relation ?? null,
      emergencyPhone: user.emergencyContact?.phone ?? null,
    };
  }

  async saveBankDetails(
    orgId: string,
    userId: string,
    input: BankDetailsInput,
  ) {
    const req = resolveCountryRequirements(input.countryCode);
    const statutory = input.statutory ?? {};
    const primaryKey = req.statutoryFields[0]?.key;
    const primaryTaxId =
      input.taxId?.trim() ||
      (primaryKey ? statutory[primaryKey]?.trim() : "") ||
      "";

    await this.db
      .update(users)
      .set({
        bankDetails: encryptBankDetails({
          accountNumber: input.accountNumber ?? "",
          bankName: input.bankName,
          branch: input.branch ?? "",
          ifsc: req.bankScheme === "IFSC" ? (input.routingCode ?? "") : "",
          accountHolder: input.accountHolder,
          bankCountry: req.countryCode,
          scheme: req.bankScheme,
          routingCode: input.routingCode?.trim() || undefined,
          iban: input.iban?.trim() || undefined,
          swift: input.swift?.trim() || undefined,
          pfUanNumber: statutory["uan"]?.trim() || undefined,
          statutory: Object.keys(statutory).length > 0 ? statutory : undefined,
        }),
        ...(primaryTaxId ? { taxId: encrypt(primaryTaxId) } : {}),
      })
      .where(eq(users.id, userId));

    await this.upsertOnboardingStep(userId, orgId, "Bank Details");

    return { success: true };
  }

  async getStatus(
    userId: string,
    orgId: string,
  ): Promise<{
    personalDetails: boolean;
    bankDetails: boolean;
    documents: number;
    submitted: boolean;
  }> {
    const [stepsResult, docCountResult, userRow] = await Promise.all([
      this.db
        .select({
          stepName: onboardingSteps.stepName,
          status: onboardingSteps.status,
        })
        .from(onboardingSteps)
        .where(
          and(
            eq(onboardingSteps.userId, userId),
            eq(onboardingSteps.orgId, orgId),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.orgId, orgId))),
      this.db
        .select({ onboardingCompletedAt: users.onboardingCompletedAt })
        .from(users)
        .where(eq(users.id, userId)),
    ]);

    const completedSteps = new Set(
      stepsResult
        .filter((s) => s.status === "COMPLETED")
        .map((s) => s.stepName),
    );

    return {
      personalDetails: completedSteps.has("Personal Details"),
      bankDetails: completedSteps.has("Bank Details"),
      documents: docCountResult[0]?.count ?? 0,
      submitted: Boolean(userRow[0]?.onboardingCompletedAt),
    };
  }

  async invalidateSessionCache(userId: string) {
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
  }

  async upsertOnboardingStep(
    userId: string,
    orgId: string,
    stepName: string,
  ) {
    const existing = await this.db.query.onboardingSteps.findFirst({
      where: and(
        eq(onboardingSteps.userId, userId),
        eq(onboardingSteps.stepName, stepName),
      ),
    });
    if (existing) {
      await this.db
        .update(onboardingSteps)
        .set({ status: "COMPLETED", completedAt: new Date() })
        .where(eq(onboardingSteps.id, existing.id));
    } else {
      await this.db.insert(onboardingSteps).values({
        userId,
        orgId,
        stepName,
        status: "COMPLETED",
        completedAt: new Date(),
      });
    }
  }
}
