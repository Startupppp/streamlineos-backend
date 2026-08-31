import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { billingProfiles } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { UpdateBillingProfileInput } from "./dto/billing.schemas";

const billingProfileColumns = {
  id: billingProfiles.id,
  orgId: billingProfiles.orgId,
  gstin: billingProfiles.gstin,
  pan: billingProfiles.pan,
  billingName: billingProfiles.billingName,
  billingEmail: billingProfiles.billingEmail,
  addressLine1: billingProfiles.addressLine1,
  addressLine2: billingProfiles.addressLine2,
  city: billingProfiles.city,
  state: billingProfiles.state,
  pincode: billingProfiles.pincode,
  country: billingProfiles.country,
  isTaxExempt: billingProfiles.isTaxExempt,
  metadata: billingProfiles.metadata,
  createdAt: billingProfiles.createdAt,
  updatedAt: billingProfiles.updatedAt,
};

@Injectable()
export class BillingProfileService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(orgId: string) {
    const [existing] = await this.db
      .select(billingProfileColumns)
      .from(billingProfiles)
      .where(eq(billingProfiles.orgId, orgId));
    if (existing) return existing;

    const [profile] = await this.db
      .insert(billingProfiles)
      .values({ orgId })
      .returning(billingProfileColumns);
    return profile;
  }

  async update(orgId: string, data: UpdateBillingProfileInput) {
    await this.get(orgId);
    const [updated] = await this.db
      .update(billingProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(billingProfiles.orgId, orgId))
      .returning(billingProfileColumns);
    return updated;
  }
}
