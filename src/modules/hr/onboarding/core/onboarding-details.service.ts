import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
import { decrypt, encrypt } from "./crypto.helpers";
import {
  readBankDetails,
  sealBankDetails,
} from "../../../../common/hr/canonical-bank-details";
import { resolveCountryRequirements } from "./onboarding-requirements.catalog";
import type {
  BankDetailsInput,
  PersonalDetailsInput,
} from "./dto/onboarding.schemas";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  livePersonOfUser,
  livePersonOfEmployment,
  primaryEmploymentOfPerson,
} from "../../../directory/employment-query";
import { PersonEmploymentSyncService } from "../../core/person-employment-sync.service";

export const BANK_DETAILS_NEED_EMPLOYMENT_MESSAGE =
  "Your employment record is not set up yet, so bank and tax details cannot be saved. Ask your HR administrator to complete your employment record, then finish this step.";

@Injectable()
export class OnboardingDetailsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly employmentSync: PersonEmploymentSyncService,
  ) {}

  async savePersonalDetails(
    orgId: string,
    userId: string,
    input: PersonalDetailsInput,
  ) {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await this.assertMembership(tx, orgId, userId);
        await this.savePersonalDetailsInTransaction(tx, orgId, userId, input);
      },
      { orgId },
    );

    return { success: true };
  }

  async savePersonalDetailsInTransaction(
    tx: Db,
    orgId: string,
    userId: string,
    input: PersonalDetailsInput,
  ): Promise<void> {
    await this.employmentSync.ensureFromUserId(orgId, userId, userId, tx);

    const emergencyContact =
      input.emergencyName && input.emergencyRelation && input.emergencyPhone
        ? {
            name: input.emergencyName,
            relation: input.emergencyRelation,
            phone: input.emergencyPhone,
          }
        : undefined;

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

    await this.upsertOnboardingStep(tx, userId, orgId, "Personal Details");
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
      .leftJoin(hrPeople, livePersonOfUser(orgId, organizationMembers.userId))
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(
            organizationPeople.organizationPersonId,
            hrPeople.organizationPersonId,
          ),
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
        user.userEmergencyContact?.name ??
        user.personEmergencyContact?.name ??
        null,
      emergencyRelation:
        user.userEmergencyContact?.relation ??
        user.personEmergencyContact?.relationship ??
        null,
      emergencyPhone:
        user.userEmergencyContact?.phone ??
        user.personEmergencyContact?.phone ??
        null,
    };
  }

  async saveBankDetails(
    orgId: string,
    userId: string,
    input: BankDetailsInput,
  ) {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await this.assertMembership(tx, orgId, userId);
        await this.saveBankDetailsInTransaction(tx, orgId, userId, input);
      },
      { orgId },
    );

    return { success: true };
  }

  async saveBankDetailsInTransaction(
    tx: Db,
    orgId: string,
    userId: string,
    input: BankDetailsInput,
  ): Promise<void> {
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

    const [employment] = await tx
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        livePersonOfEmployment(orgId, hrEmployments, hrPeople),
      )
      .where(
        and(
          primaryEmploymentOfPerson(orgId, hrPeople, hrEmployments),
          eq(hrPeople.userId, userId),
        ),
      )
      .limit(1);

    const employmentId =
      employment?.id ??
      (await this.employmentSync.ensureFromUserId(orgId, userId, userId, tx))
        ?.employmentId;

    if (!employmentId)
      throw new ConflictException(BANK_DETAILS_NEED_EMPLOYMENT_MESSAGE);

    const sealedBankDetails = sealBankDetails(bankDetails);
    await tx
      .insert(hrEmployeeSensitiveFields)
      .values({
        orgId,
        employmentId,
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

    await this.upsertOnboardingStep(tx, userId, orgId, "Bank Details");
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
      .leftJoin(hrPeople, livePersonOfUser(orgId, organizationMembers.userId))
      .leftJoin(
        hrEmployments,
        primaryEmploymentOfPerson(orgId, hrPeople, hrEmployments),
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

    const bank = user.sensitiveBankDetails
      ? readBankDetails(user.sensitiveBankDetails)
      : null;
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
        )
        .limit(1_000),
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

  private async assertMembership(
    tx: Db,
    orgId: string,
    userId: string,
  ): Promise<void> {
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
  }

  async upsertOnboardingStep(
    tx: Db,
    userId: string,
    orgId: string,
    stepName: string,
  ) {
    const existing = await tx.query.onboardingSteps.findFirst({
      where: and(
        eq(onboardingSteps.userId, userId),
        eq(onboardingSteps.orgId, orgId),
        eq(onboardingSteps.stepName, stepName),
      ),
    });
    if (existing) {
      await tx
        .update(onboardingSteps)
        .set({ status: "COMPLETED", completedAt: new Date() })
        .where(eq(onboardingSteps.id, existing.id));
    } else {
      await tx.insert(onboardingSteps).values({
        userId,
        orgId,
        stepName,
        status: "COMPLETED",
        completedAt: new Date(),
      });
    }
  }
}
