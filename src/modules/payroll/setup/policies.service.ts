import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreatePolicyInput,
  UpdatePolicyInput,
  PolicyPreviewInput,
  ActivatePolicyInput,
  CreatePolicyVersionInput,
  ToggleImpactInput,
} from "./dto/setup.schemas";
import { PolicyQueryService } from "./policy-query.service";
import { PolicyMutationService } from "./policy-mutation.service";

@Injectable()
export class PayrollPoliciesService {
  constructor(
    private readonly query: PolicyQueryService,
    private readonly mutation: PolicyMutationService,
  ) {}

  getCurrent(orgId: string) {
    return this.query.getCurrent(orgId);
  }

  create(u: CurrentUserContext, input: CreatePolicyInput) {
    return this.mutation.create(u, input);
  }

  update(u: CurrentUserContext, policyId: number, input: UpdatePolicyInput) {
    return this.mutation.update(u, policyId, input);
  }

  preview(orgId: string, input: PolicyPreviewInput) {
    return this.query.preview(orgId, input);
  }

  activate(u: CurrentUserContext, policyId: number, input: ActivatePolicyInput) {
    return this.mutation.activate(u, policyId, input);
  }

  createVersion(u: CurrentUserContext, policyId: number, input: CreatePolicyVersionInput) {
    return this.mutation.createVersion(u, policyId, input);
  }

  listVersions(orgId: string, policyId: number) {
    return this.query.listVersions(orgId, policyId);
  }

  toggleImpact(orgId: string, input: ToggleImpactInput) {
    return this.query.toggleImpact(orgId, input);
  }
}
