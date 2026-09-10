import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

/**
 * Response contract for `OrgController` (setup) handlers.
 *
 * Derived from `OrgSetupService` and `OrgMembersService` return values.
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

/**
 * `OrgMembersService.listMembers` — lightweight member projection returned
 * for the org-setup member search. The exact columns vary by service version;
 * the common subset is declared here. NOT strict so added fields pass.
 */
export const orgMemberItemSchema = z.object({
  userId: z.string().optional(),
  membershipId: z.number().int().optional(),
  name: z.string().nullable().optional(),
  email: z.string().optional(),
  image: z.string().nullable().optional(),
  status: z.string().optional(),
});

export const orgMemberListResponseSchema = z.array(orgMemberItemSchema);

/**
 * `OrgSetupService.getSetupSession` — returns either a full
 * `onboarding_flow_sessions` row (via `OnboardingSessionService`) or a
 * lightweight ephemeral object when no org context exists yet.
 *
 * The ephemeral shape has only the seven base fields; DB rows include the
 * additional optional columns. The schema declares the intersection as
 * required and marks DB-only columns optional so both pass safeParse.
 */
export const orgSetupSessionResponseSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: z.string(),
  currentStep: z.string().nullable(),
  completedSteps: z.array(z.string()),
  skippedSteps: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  membershipId: z.number().int().nullable().optional(),
  source: z.string().nullable().optional(),
  startedAt: nullableWireDate().optional(),
  completedAt: nullableWireDate().optional(),
  lastSeenAt: wireDate().optional(),
  createdAt: wireDate().optional(),
  updatedAt: wireDate().optional(),
});

/**
 * `OrgSetupService.completeSetup` — owner path includes an `autoLoginToken`;
 * non-owner path returns only `{ success, orgId }`. Declared as a union so
 * both branches pass without widening the token to optional.
 */
export const orgSetupCompleteResponseSchema = z.union([
  z.object({ success: z.literal(true), orgId: z.string(), autoLoginToken: z.string() }),
  z.object({ success: z.literal(true), orgId: z.string() }),
]);

/**
 * `OrgSetupService.skipSetup` — owner and non-owner paths both return this
 * shape, but the owner path also includes an `autoLoginToken`.
 */
export const orgSetupSkipResponseSchema = z.union([
  z.object({ success: z.literal(true), orgId: z.string(), autoLoginToken: z.string() }),
  z.object({ success: z.literal(true), orgId: z.string() }),
]);

/** `WorkspaceOnboardingService.generateWorkspace` — ids of created units. */
export const generateWorkspaceResponseSchema = z.object({
  businessUnits: z.array(z.string()),
  branches: z.array(z.string()),
  departments: z.array(z.string()),
  teams: z.array(z.string()),
});

/**
 * `OrgSetupService.getSetupStatus` — what the wizard polls once it has fired
 * `POST /org/setup/complete`.
 *
 * `onboardingCompletedAt` is the durable stamp: once it is non-null the wizard is finished and
 * replaying it is a no-op. `provisioning` reports the asynchronous half that the setup-completed
 * outbox consumer owns (roles, checklists, workspace structure, invitations, welcome), read from
 * that consumer's inbox row — `pending` means the row has committed but the relay has not picked
 * the event up yet, which is not the same as nothing having happened.
 */
export const orgSetupStatusResponseSchema = z.object({
  orgId: z.string().nullable(),
  onboardingCompletedAt: nullableWireDate(),
  provisioning: z.enum([
    "not-started",
    "pending",
    "in-progress",
    "completed",
    "failed",
  ]),
  lastError: z.string().nullable(),
});
