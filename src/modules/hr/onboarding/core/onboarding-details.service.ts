import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  documents,
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  onboardingSteps,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { organizationPeople } from "../../../../db/schema/directory/organization-people";
import {
  decrypt,
  encrypt,
} from "./crypto.helpers";
import { sealSensitiveJson } from "../../../../common/security/sensitive-field";
import { readBankDetails } from "../../../../common/hr/canonical-bank-details";
import { resolveCountryRequirements } from "./onboarding-requirements.catalog";
import type { BankDetailsInput, PersonalDetailsInput } from "./dto/onboarding.schemas";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

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

    await runInTenantTransaction(this.db, async (tx) => {
      const membership = await tx.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
        columns: { id: true },
      });
      if (!membership) {
        throw new NotFoundException("User not found in this organization");
      }

      await tx
        .update(users)
        .set({
          phone: input.phone,
          ...(input.gender ? { gender: input.gender } : {}),
          ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
          ...(emergencyContact ? { emergencyContact } : {}),
        })
        .where(eq(users.id, userId));

      await tx
        .update(organizationPeople)
        .set({
          phone: input.phone,
          ...(input.gender ? { gender: input.gender } : {}),
          ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
          address: {
            line1: input.addressLine1,
            city: input.addressCity,
            state: input.addressState,
            postalCode: input.addressPostalCode,
            country: input.addressCountry,
          },
          ...(emergencyContact
            ? {
                emergencyContact: {
                  name: emergencyContact.name,
                  relationship: emergencyContact.relation,
                  phone: emergencyContact.phone,
                },
              }
            : {}),
        })
        .where(
          and(
            eq(organizationPeople.organizationId, orgId),
            eq(organizationPeople.userId, userId),
            isNull(organizationPeople.deletedAt),
          ),
        );
    }, { orgId });

    await this.upsertOnboardingStep(userId, orgId, "Personal Details");

    return { success: true };
  }

  async getPersonalDetails(orgId: string, userId: string) {
    const [user] = await this.db
      .select({
        userPhone: users.phone,
        userGender: users.gender,
        userDateOfBirth: users.dateOfBirth,
        userEmergencyContact: users.emergencyContact,
        personPhone: organizationPeople.phone,
        personGender: organizationPeople.gender,
        personDateOfBirth: organizationPeople.dateOfBirth,
        personAddress: organizationPeople.address,
        personEmergencyContact: organizationPeople.emergencyContact,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, organizationMembers.orgId),
          eq(hrPeople.userId, organizationMembers.userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
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
      phone: user.userPhone ?? user.personPhone,
      gender: user.userGender ?? user.personGender,
      dateOfBirth: user.userDateOfBirth ?? user.personDateOfBirth,
      addressLine1: user.personAddress?.line1 ?? null,
      addressCity: user.personAddress?.city ?? null,
      addressState: user.personAddress?.state ?? null,
      addressPostalCode: user.personAddress?.postalCode ?? null,
      addressCountry: user.personAddress?.country ?? null,
      emergencyName:
        user.userEmergencyContact?.name ?? user.personEmergencyContact?.name ?? null,
      emergencyRelation:
        user.userEmergencyContact?.relation ??
        user.personEmergencyContact?.relationship ??
        null,
      emergencyPhone:
        user.userEmergencyContact?.phone ?? user.personEmergencyContact?.phone ?? null,
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
    const bankDetails = {
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
      esiIpNumber: statutory["esi"]?.trim() || undefined,
      statutory: Object.keys(statutory).length > 0 ? statutory : undefined,
    };
    const encryptedTaxId = primaryTaxId ? encrypt(primaryTaxId) : undefined;

    await runInTenantTransaction(this.db, async (tx) => {
      const membership = await tx.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
        columns: { id: true },
      });
      if (!membership) {
        throw new NotFoundException("User not found in this organization");
      }

      const [employment] = await tx
        .select({ id: hrEmployments.id })
        .from(hrEmployments)
        .innerJoin(
          hrPeople,
          and(
            eq(hrPeople.id, hrEmployments.personId),
            eq(hrPeople.orgId, hrEmployments.orgId),
          ),
        )
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.isPrimary, true),
            isNull(hrEmployments.deletedAt),
            eq(hrPeople.userId, userId),
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1);

      if (employment) {
        const sensitiveBankDetails = {
          accountNumber: bankDetails.accountNumber,
          bankName: bankDetails.bankName,
          branch: bankDetails.branch,
          ifsc: bankDetails.ifsc,
          swift: bankDetails.swift,
          accountHolder: bankDetails.accountHolder,
          pfUanNumber: bankDetails.pfUanNumber,
          esiIpNumber: bankDetails.esiIpNumber,
          iban: bankDetails.iban,
          routingNumber: bankDetails.routingCode,
        };
        const sealedBankDetails = sealSensitiveJson(sensitiveBankDetails);
        await tx
          .insert(hrEmployeeSensitiveFields)
          .values({
            orgId,
            employmentId: employment.id,
            bankDetails: sealedBankDetails,
            taxId: encryptedTaxId ?? null,
          })
          .onConflictDoUpdate({
            target: hrEmployeeSensitiveFields.employmentId,
            set: {
              bankDetails: sealedBankDetails,
              ...(encryptedTaxId ? { taxId: encryptedTaxId } : {}),
              updatedAt: new Date(),
            },
          });
      }
    }, { orgId });

    await this.upsertOnboardingStep(userId, orgId, "Bank Details");

    return { success: true };
  }

  async getBankDetails(orgId: string, userId: string) {
    const [user] = await this.db
      .select({
        sensitiveBankDetails: hrEmployeeSensitiveFields.bankDetails,
        sensitiveTaxId: hrEmployeeSensitiveFields.taxId,
        sensitivePanNumber: hrEmployeeSensitiveFields.panNumber,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, organizationMembers.orgId),
          eq(hrPeople.userId, organizationMembers.userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployments,
        and(
          eq(hrEmployments.orgId, organizationMembers.orgId),
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployeeSensitiveFields,
        and(
          eq(hrEmployeeSensitiveFields.orgId, organizationMembers.orgId),
          eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id),
        ),
      )
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

    const bank = user.sensitiveBankDetails ? readBankDetails(user.sensitiveBankDetails) : null;
    const countryCode = bank?.bankCountry ?? "IN";
    const requirements = resolveCountryRequirements(countryCode);
    const statutory = { ...(bank?.statutory ?? {}) };
    const primaryStatutoryKey = requirements.statutoryFields[0]?.key;
    const encryptedTaxId = user.sensitiveTaxId ?? user.sensitivePanNumber;
    if (encryptedTaxId && primaryStatutoryKey) {
      statutory[primaryStatutoryKey] ??= decrypt(encryptedTaxId);
    }
    if (bank?.pfUanNumber) statutory.uan ??= bank.pfUanNumber;
    if (bank?.esiIpNumber) statutory.esi ??= bank.esiIpNumber;

    return {
      countryCode: bank ? countryCode : "",
      accountHolder: bank?.accountHolder ?? "",
      bankName: bank?.bankName ?? "",
      accountNumber: bank?.accountNumber ?? "",
      routingCode: bank?.routingCode ?? bank?.ifsc ?? "",
      iban: bank?.iban ?? "",
      swift: bank?.swift ?? "",
      statutory,
    };
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
    const [stepsResult, docCountResult] = await Promise.all([
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
      submitted: completedSteps.has("Final Review"),
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
        eq(onboardingSteps.orgId, orgId),
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
