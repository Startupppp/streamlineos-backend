import type { Table } from "drizzle-orm";
import { candidateApplications, candidateOffers, candidateSources, candidates, interviews } from "src/db/schema";
import type { AuditService } from "src/common/audit/audit.service";
import { ProviderCredentialsService } from "src/modules/hr/recruitment/integrations/provider-credentials.service";
import { RecruitmentIntegrationsService } from "src/modules/hr/recruitment/integrations/recruitment-integrations.service";
import { InternalMobilityService } from "src/modules/hr/recruitment/internal-mobility/internal-mobility.service";
import { RecruitmentOfferAcceptanceService } from "src/modules/hr/recruitment/recruitment-offer-acceptance.service";
import { SourcedProfileService } from "src/modules/hr/recruitment/sourcing-extension/sourced-profile.service";
import { VoiceScreenService } from "src/modules/hr/recruitment/voice-screen/voice-screen.service";
import { WhatsappService } from "src/modules/hr/recruitment/whatsapp/whatsapp.service";
import type { Observation, Scenario } from "../matrix.types";
import { cache } from "../adapters/real-services";
import { tenantBound } from "../adapters/hr-adapter";
import { outcomeOfError } from "../matrix-runner";
import { ORG_A, ORG_B } from "../standings";
import { standIn, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, boundBy, freshWorld, markOf, pair, victimOf } from "./isolation-kit";
import { onboardingStartScenarios } from "./recruitment-onboarding-isolation-scenarios";

const SOURCE_A = 7101;
const APPLICATION_A = 7301;
const MANAGER_MEMBERSHIP_A = 7302;
const OFFER_A = 7401;
const CANDIDATE_A = 7601;
const INTERVIEW_A = 7701;
const PLATFORM = "NAUKRI";
const TOKEN = "plain-naukri-token";
const PROFILE_URL = "https://www.linkedin.com/in/ada-sourced";
const STORED_PROFILE_URL = "https://linkedin.com/in/ada-sourced";
const CREATED = new Date("2026-08-01T00:00:00Z");

const audit = standIn<AuditService>({ log: () => undefined, logCritical: async () => undefined });

function rows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [candidateSources, [{ id: SOURCE_A, orgId: ORG_A, platform: PLATFORM, isActive: true, oauthToken: TOKEN, meta: {} }]],
    [
      candidateApplications,
      [{ id: APPLICATION_A, orgId: ORG_A, internalManagerMembershipId: MANAGER_MEMBERSHIP_A, internalManagerDecision: "PENDING" }],
    ],
    [candidateOffers, [{ id: OFFER_A, orgId: ORG_A, candidateId: CANDIDATE_A, jobPostingId: null, offerStatus: "SENT" }]],
    [
      candidates,
      [
        {
          id: CANDIDATE_A,
          orgId: ORG_A,
          firstName: "Ada",
          lastName: "Sourced",
          email: "ada@example.com",
          phone: "+919800000001",
          status: "NEW",
          sourceUrl: STORED_PROFILE_URL,
          whatsappOptInAt: null,
          whatsappOptOutAt: null,
        },
      ],
    ],
    [
      interviews,
      [
        {
          id: INTERVIEW_A,
          orgId: ORG_A,
          candidateId: CANDIDATE_A,
          type: "VOICE_SCREEN",
          externalRef: "vs-ref-a",
          result: "PENDING",
          rating: null,
          rubric: { script: ["Why us?"], answers: [], completedBy: null },
          scheduledAt: CREATED,
        },
      ],
    ],
  ]);
}

function rowOf(world: WorldDb, table: Table, id: number): Row | undefined {
  return (world.rows.get(table) ?? []).find((row) => row.id === id);
}

async function isolated(
  world: WorldDb,
  callerOrg: string,
  table: string,
  work: () => Promise<unknown>,
  reachedOwn: (value: unknown) => boolean,
  extra: (value: unknown) => Readonly<Record<string, boolean>> = () => ({}),
): Promise<Observation> {
  const mark = markOf(world);
  const tenantChecks = (): Record<string, boolean> => {
    const bound = boundBy(world, mark, table);
    return { statementBindsCallerOrg: bound.includes(callerOrg), statementNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)) };
  };
  let value: unknown;
  try {
    value = await work();
  } catch (error: unknown) {
    return { outcome: outcomeOfError(error), checks: { ...tenantChecks(), ...extra(undefined) } };
  }
  return { outcome: reachedOwn(value) ? "allow" : "404", checks: { ...tenantChecks(), ...extra(value) } };
}

function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

function credentials(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    return isolated(
      world,
      callerOrg,
      "candidate_sources",
      () => new ProviderCredentialsService(world.db).forPlatform(callerOrg, PLATFORM),
      (value) => hasKey(value, "token") && value.token === TOKEN,
      (value) => ({ noForeignTokenReturned: callerOrg === ORG_A || value === null }),
    );
  };
  const entry = "ProviderCredentialsService.forPlatform(orgId) <- the integrations connect flow";
  return pair(
    { ...TENANT_ONLY, resource: "hr:recruitment-provider-credential", action: "read" },
    "hr-recruitment-provider-credential-read",
    { because: "the caller's own saved provider credential resolves with its token", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the credential lookup binds the requesting org, so another organisation's provider token is never returned and the miss reads as absent",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function disconnect(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    const service = new RecruitmentIntegrationsService(world.db, new ProviderCredentialsService(world.db), audit);
    return isolated(
      world,
      callerOrg,
      "candidate_sources",
      () => service.disconnect(callerOrg, `${callerOrg}:recruiter`, PLATFORM),
      () => rowOf(world, candidateSources, SOURCE_A) === undefined,
    );
  };
  const entry = "RecruitmentIntegrationsService.disconnect(orgId) <- DELETE /hr/recruitment/integrations/:platform";
  return pair(
    { ...TENANT_ONLY, resource: "hr:recruitment-integration", action: "disconnect" },
    "hr-recruitment-integration-disconnect",
    { because: "the caller's own connection row is deleted under its org", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the delete binds the requesting org, so disconnecting the same platform from another organisation leaves the victim's connection in place",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function mobilityDecision(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    const service = new InternalMobilityService(world.db, standIn({}), audit);
    return isolated(
      world,
      callerOrg,
      "candidate_applications",
      () => service.decide(callerOrg, MANAGER_MEMBERSHIP_A, `${callerOrg}:manager`, APPLICATION_A, "APPROVED", null),
      (value) => hasKey(value, "id") && value.id === APPLICATION_A,
      () => ({
        victimDecisionUntouched: callerOrg === ORG_A || rowOf(world, candidateApplications, APPLICATION_A)?.internalManagerDecision === "PENDING",
      }),
    );
  };
  const entry = "InternalMobilityService.decide(orgId) <- POST /hr/recruitment/internal-mobility/approvals/:applicationId";
  return pair(
    { ...TENANT_ONLY, resource: "hr:internal-mobility-approval", action: "decide" },
    "hr-internal-mobility-decide",
    { because: "the caller's own pending internal application is decided by its named manager", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the guarded update binds the requesting org, so even the victim manager's membership id decides nothing in another organisation and the answer is 404",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function offerClaim(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    const service = new RecruitmentOfferAcceptanceService(world.db, standIn({}), audit, standIn({}), standIn({}), standIn({}));
    return isolated(
      world,
      callerOrg,
      "candidate_offers",
      () => service.claimResponse(world.db, callerOrg, OFFER_A, "ACCEPTED"),
      (value) => hasKey(value, "candidateId") && value.candidateId === CANDIDATE_A,
      () => ({ victimOfferStillSent: callerOrg === ORG_A || rowOf(world, candidateOffers, OFFER_A)?.offerStatus === "SENT" }),
    );
  };
  const entry = "RecruitmentOfferAcceptanceService.claimResponse(orgId) <- POST /public/offers/:token/respond";
  return pair(
    { ...TENANT_ONLY, resource: "hr:candidate-offer", action: "respond" },
    "hr-candidate-offer-claim-response",
    { because: "the caller's own sent offer is claimed exactly once and reports its candidate", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the claim binds the requesting org, so another organisation's offer id is never moved out of SENT and the claim returns nothing",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function sourcedLookup(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    const service = new SourcedProfileService(world.db, audit, cache, standIn({}));
    return isolated(
      world,
      callerOrg,
      "candidates",
      () => service.lookup(callerOrg, PROFILE_URL),
      (value) => hasKey(value, "candidateId") && value.candidateId === CANDIDATE_A,
      (value) => ({ noForeignCandidateNamed: callerOrg === ORG_A || (hasKey(value, "firstName") && value.firstName === null) }),
    );
  };
  const entry = "SourcedProfileService.lookup(orgId) <- GET /hr/recruitment/sourcing/lookup";
  return pair(
    { ...TENANT_ONLY, resource: "hr:sourced-profile", action: "lookup" },
    "hr-sourced-profile-lookup",
    { because: "a profile URL the caller's organisation already holds resolves to its candidate", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the URL match binds the requesting org, so the extension never tells another organisation whom the victim has already sourced",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function voiceScreens(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    const service = new VoiceScreenService(world.db, audit, new ProviderCredentialsService(world.db));
    const listed = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
    return isolated(
      world,
      callerOrg,
      "interviews",
      () => service.listForCandidate(callerOrg, CANDIDATE_A),
      (value) => listed(value).some((row) => hasKey(row, "id") && row.id === INTERVIEW_A),
      (value) => ({ noForeignScreenListed: callerOrg === ORG_A || listed(value).length === 0 }),
    );
  };
  const entry = "VoiceScreenService.listForCandidate(orgId) <- GET /hr/recruitment/candidates/:candidateId/voice-screens";
  return pair(
    { ...TENANT_ONLY, resource: "hr:voice-screen", action: "list" },
    "hr-voice-screen-list",
    { because: "the caller's own candidate lists its requested voice screen", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the interview read binds the requesting org, so another organisation's candidate id lists none of the victim's screens or answers",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function whatsappConsent(): Scenario[] {
  const run = (callerOrg: string) => () => {
    const world = freshWorld(rows());
    const service = new WhatsappService(world.db, audit, new ProviderCredentialsService(world.db));
    return tenantBound(
      world,
      { callerOrg, victimOrg: victimOf(callerOrg), ids: [CANDIDATE_A] },
      () => service.recordConsent(callerOrg, `${callerOrg}:recruiter`, CANDIDATE_A, true),
      { lookup: "candidates", writes: { table: "candidates", verb: "update" } },
      () => ({ victimConsentUntouched: callerOrg === ORG_A || rowOf(world, candidates, CANDIDATE_A)?.whatsappOptInAt === null }),
    );
  };
  const entry = "WhatsappService.recordConsent(orgId) <- POST /hr/recruitment/candidates/:candidateId/whatsapp/consent";
  return pair(
    { ...TENANT_ONLY, resource: "hr:whatsapp-consent", action: "record" },
    "hr-whatsapp-consent-record",
    { because: "the caller's own candidate is found under its org and its opt-in is stamped once", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the candidate is resolved under the caller's org first, so another organisation's candidate answers 404 and no consent is written",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

export function recruitmentIntegrationsIsolationScenarios(): Scenario[] {
  return [
    ...credentials(),
    ...disconnect(),
    ...mobilityDecision(),
    ...offerClaim(),
    ...sourcedLookup(),
    ...voiceScreens(),
    ...whatsappConsent(),
    ...onboardingStartScenarios(),
  ];
}
