import { Injectable } from "@nestjs/common";
import type { InviteActor } from "./invitations.service";
import { OrgProfileService } from "./org-profile.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgPurgeService } from "./org-purge.service";
import type {
  CreateOrganizationInput,
  ListMembersInput,
} from "./dto/organization.schemas";

@Injectable()
export class OrganizationService {
  constructor(
    private readonly orgProfile: OrgProfileService,
    private readonly orgMembership: OrgMembershipService,
    private readonly orgMembershipStatus: OrgMembershipStatusService,
    private readonly orgMemberDeparture: OrgMemberDepartureService,
    private readonly orgLifecycle: OrgLifecycleService,
    private readonly orgPurge: OrgPurgeService,
  ) {}

  async listUserOrganizations(userId: string) {
    return this.orgProfile.listUserOrganizations(userId);
  }

  async switchOrg(userId: string, targetOrgId: string) {
    return this.orgProfile.switchOrg(userId, targetOrgId);
  }

  async createOrganization(userId: string, input: CreateOrganizationInput) {
    return this.orgProfile.createOrganization(userId, input);
  }

  async getProfile(userId: string, orgId: string) {
    return this.orgProfile.getProfile(userId, orgId);
  }

  async listMembers(orgId: string, input: ListMembersInput) {
    return this.orgMembership.listMembers(orgId, input);
  }

  async removeMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.orgMemberDeparture.removeMember(orgId, actorUserId, memberUserId);
  }

  async suspendMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.orgMembershipStatus.suspendMember(orgId, actorUserId, memberUserId);
  }

  async reactivateMember(orgId: string, actorUserId: string, memberUserId: string) {
    return this.orgMembershipStatus.reactivateMember(orgId, actorUserId, memberUserId);
  }

  async updateMemberRole(
    orgId: string,
    actor: InviteActor,
    memberUserId: string,
    role: string,
  ) {
    return this.orgMembership.updateMemberRole(orgId, actor, memberUserId, role);
  }

  async leaveOrg(orgId: string, userId: string) {
    return this.orgMemberDeparture.leaveOrg(orgId, userId);
  }

  async listArchivedOwnedOrganizations(userId: string) {
    return this.orgLifecycle.listArchivedOwnedOrganizations(userId);
  }

  async archiveOrg(orgId: string, userId: string) {
    return this.orgLifecycle.archiveOrg(orgId, userId);
  }

  async restoreOrg(orgId: string, userId: string) {
    return this.orgLifecycle.restoreOrg(orgId, userId);
  }

  async deleteOrg(orgId: string, userId: string, confirmation: string) {
    return this.orgPurge.deleteOrg(orgId, userId, confirmation);
  }

  async schedulePurge(
    orgId: string,
    actorUserId: string,
    scheduledForDays: number,
    reason: string,
  ) {
    return this.orgPurge.schedulePurge(orgId, actorUserId, scheduledForDays, reason);
  }

  async cancelPurge(orgId: string, actorUserId: string) {
    return this.orgPurge.cancelPurge(orgId, actorUserId);
  }
}
