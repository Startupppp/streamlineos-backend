import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { resolvePerson } from "../../directory/person-seam";
import type { PersonEmployment, PersonResolutionPath } from "../../directory/person-seam";

export type PayeeEligibilityReason =
  | "payable"
  | "employed-but-not-payable"
  | "not-payable"
  | "unknown-person";

export type PayeeEligibility = {
  organizationPersonId: string;
  payable: boolean;
  payableAs: "user" | "worker" | null;
  payeeUserId: string | null;
  payeeWorkerId: string | null;
  resolvedVia: PersonResolutionPath | null;
  employment: PersonEmployment | null;
  reason: PayeeEligibilityReason;
};

@Injectable()
export class PayeeEligibilityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getEligibility(
    orgId: string,
    organizationPersonId: string,
  ): Promise<PayeeEligibility> {
    const resolution = await resolvePerson(this.db, orgId, {
      kind: "person",
      organizationPersonId,
    });

    if (resolution.status !== "resolved") {
      return {
        organizationPersonId,
        payable: false,
        payableAs: null,
        payeeUserId: null,
        payeeWorkerId: null,
        resolvedVia: null,
        employment: null,
        reason: "unknown-person",
      };
    }

    const { payableAs, resolvedVia, employment } = resolution.person;

    return {
      organizationPersonId,
      payable: payableAs !== null,
      payableAs: payableAs?.kind ?? null,
      payeeUserId: payableAs?.kind === "user" ? payableAs.userId : null,
      payeeWorkerId: payableAs?.kind === "worker" ? payableAs.workerId : null,
      resolvedVia,
      employment,
      reason: eligibilityReason(payableAs !== null, employment),
    };
  }
}

function eligibilityReason(
  payable: boolean,
  employment: PersonEmployment | null,
): PayeeEligibilityReason {
  if (payable) return "payable";
  return employment ? "employed-but-not-payable" : "not-payable";
}
