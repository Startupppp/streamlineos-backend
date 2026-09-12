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

type BillingProfileRow = Pick<typeof billingProfiles.$inferSelect, keyof typeof billingProfileColumns>;

function defaultBillingProfile(orgId: string): BillingProfileRow {
  const now = new Date();
  return {
    id: 0,
    orgId,
    gstin: null,
    pan: null,
    billingName: null,
    billingEmail: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    pincode: null,
    country: null,
    isTaxExempt: false,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

@Injectable()
export class BillingProfileService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(orgId: string): Promise<BillingProfileRow> {
    const [existing] = await this.db
      .select(billingProfileColumns)
      .from(billingProfiles)
      .where(eq(billingProfiles.orgId, orgId));
    return existing ?? defaultBillingProfile(orgId);
  }

  async update(orgId: string, data: UpdateBillingProfileInput): Promise<BillingProfileRow> {
    const [upserted] = await this.db
      .insert(billingProfiles)
      .values({ orgId, ...data })
      .onConflictDoUpdate({
        target: billingProfiles.orgId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning(billingProfileColumns);
    return upserted ?? defaultBillingProfile(orgId);
  }
}
