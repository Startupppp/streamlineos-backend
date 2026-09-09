import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../common/auth/principal";
import type { ActivityActorKind } from "../../db/schema/crm/activities";
import type { Db } from "../../db/drizzle.types";
import { activities, organizationMembers, users } from "../../db/schema";
import { callAnalyses, callAnalysisReleases } from "../../db/schema/crm/call-analysis";
import type { AccessService } from "../access/access.service";
import { CallAnalysisCohortService } from "./call-analysis-cohort.service";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import type { CallRecordingConsentService } from "./call-recording-consent.service";

/**
 * The doubles both CRM-P2-05 and CRM-P2-06 service specs are built on.
 *
 * Shared rather than copied because the two specs assert different halves of one
 * rule and have to be built on the same lie about the database — a fix to one
 * spec's private double silently stops covering the other, and the thing being
 * covered is whether a colleague's call can reach an aggregate.
 *
 * The lie is deliberately thin. It dispatches on the table, ignores the
 * projection, and records the organisation every read was scoped to, so a query
 * that lost its tenant predicate cannot pass as one that has it. Nothing here
 * uses a Jest global: the file is compiled by `tsconfig.build.json` like any
 * other non-spec source, and a `jest.fn()` in it would be a test-framework
 * reference sitting in a production build's type graph.
 */

export const ORG = "org-under-test";
export const HOUR = 60 * 60 * 1000;

export interface FixtureAnalysis {
  organizationId: string;
  activityId: string;
  analyzerVersion: number;
  /**
   * The column and the projection, both, kept equal by `analysis()`.
   *
   * The cohort service selects `analysedAt: callAnalyses.createdAt`. The double
   * returns fixture rows verbatim instead of applying the projection, so a
   * fixture carrying only `createdAt` would hand the visibility rule `undefined`
   * and every window computation would read a date that is not a date — the trap
   * `call-coaching.service.spec.ts` documents at length.
   */
  createdAt: Date;
  analysedAt: Date;
  talkRatioBps: number | null;
  repTurnCount: number | null;
  repQuestionCount: number | null;
  objections: { quote: string; handling: string; response: string | null }[];
  competitorMentions: { name: string; quote: string }[];
  nextStepCommitted: boolean;
}

export interface FixtureActivity {
  organizationId: string;
  activityId: string;
  actorUserId: string | null;
  /**
   * Required, never defaulted. `activities.actor_kind` is NOT NULL and the
   * visibility service reads the rep as `actorKind === "human" ? actorUserId :
   * null`; a fixture that omitted it would resolve every call to `repUserId:
   * null`, take the `unattributed` branch, and make every row visible to
   * everybody — under which a leak test passes while proving nothing.
   */
  actorKind: ActivityActorKind;
  occurredAt: Date;
}

export interface FixtureMember {
  userId: string;
  organizationId: string;
  name: string | null;
}

export function contextFor(userId: string, orgId = ORG): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: `sess-${userId}`,
    tokenScopes: null,
    principal: ACCOUNT_ONLY_PRINCIPAL,
  };
}

export function analysis(
  over: Partial<FixtureAnalysis> & { activityId: string },
): FixtureAnalysis {
  const row = {
    organizationId: ORG,
    analyzerVersion: 1,
    createdAt: new Date(Date.now() - 48 * HOUR),
    talkRatioBps: 5000,
    repTurnCount: 12,
    repQuestionCount: 4,
    objections: [],
    competitorMentions: [],
    nextStepCommitted: false,
    ...over,
  };
  return { ...row, analysedAt: row.analysedAt ?? row.createdAt };
}

export function humanCall(
  activityId: string,
  actorUserId: string,
  over: Partial<FixtureActivity> = {},
): FixtureActivity {
  return {
    organizationId: ORG,
    activityId,
    actorUserId,
    actorKind: "human",
    occurredAt: new Date(Date.now() - 49 * HOUR),
    ...over,
  };
}

/** See `call-analysis-release.spec.ts` for why only these two shapes are walked. */
function paramValues(clause: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["queryChunks"])) {
      for (const chunk of record["queryChunks"]) walk(chunk);
      return;
    }
    if ("value" in record && "encoder" in record) found.push(record["value"]);
  };
  walk(clause);
  return found;
}

/**
 * A database that answers the four reads these services make, and records the
 * organisation each one was scoped to.
 *
 * `users` is reached only through an inner join to `organization_members`, which
 * is the property `resolveRepNames` exists for: a user id with no membership in
 * this organisation resolves to no name at all. The double honours that by
 * filtering members on the organisation bound in the join clause, so a lookup
 * that dropped the join would return nothing rather than silently resolving a
 * name from another tenant.
 */
export function makeCallIntelligenceDb(
  analyses: FixtureAnalysis[],
  calls: FixtureActivity[],
  members: FixtureMember[] = [],
): { db: Db; orgsAsked: unknown[] } {
  const orgsAsked: unknown[] = [];
  let joinOrg: unknown = null;

  const rowsFor = (table: unknown, clause: unknown): unknown[] => {
    const params = paramValues(clause);
    const org = params[0];

    if (table === callAnalyses) {
      orgsAsked.push(org);
      return analyses.filter((row) => row.organizationId === org);
    }
    if (table === activities) {
      orgsAsked.push(org);
      return calls.filter((row) => row.organizationId === org);
    }
    if (table === callAnalysisReleases) {
      orgsAsked.push(org);
      // No releases in any fixture here: every visible row is visible because
      // its window elapsed, so nothing can pass by accident on a release.
      return [];
    }
    if (table === users) {
      const ids = params.find((value) => Array.isArray(value));
      return members
        .filter((row) => row.organizationId === joinOrg)
        .filter((row) => (Array.isArray(ids) ? ids.includes(row.userId) : true))
        .map((row) => ({ userId: row.userId, name: row.name }));
    }
    throw new Error("unexpected table read by a call intelligence service");
  };

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const terminal = (clause: unknown) => {
          const rows = rowsFor(table, clause);
          return {
            orderBy: () => ({ limit: async () => rows }),
            limit: async () => rows,
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
          };
        };
        return {
          where: terminal,
          innerJoin: (joined: unknown, onClause: unknown) => {
            if (joined === organizationMembers) {
              joinOrg = paramValues(onClause)[0];
              orgsAsked.push(joinOrg);
            }
            return { where: terminal };
          },
        };
      },
    }),
  };

  return { db: db as unknown as Db, orgsAsked };
}

/**
 * A consent service that allows every call.
 *
 * The default, so that a spec about visibility keeps testing visibility. The
 * exemplar spec replaces it with `consentRefusing`, which is the only way to
 * prove the consent gate bites rather than merely that it exists.
 */
export function consentAllowing(): CallRecordingConsentService {
  return consentRefusing([]);
}

/** Allows everything except the named activities. */
export function consentRefusing(refusedIds: readonly string[]): CallRecordingConsentService {
  const refused = new Set(refusedIds);
  return {
    decideMany: async (_org: string, ids: readonly string[]) =>
      new Map(
        ids.map((id) => [
          id,
          refused.has(id)
            ? {
                activityId: id,
                verdict: {
                  allowed: false as const,
                  regime: "two-party" as const,
                  jurisdiction: "DE",
                  reason: "counterparty-consent-missing" as const,
                  ruleVersion: 1,
                  note: "There is no evidence the other party agreed to this call being recorded.",
                },
                basis: null,
              }
            : {
                activityId: id,
                verdict: {
                  allowed: true as const,
                  regime: "one-party" as const,
                  jurisdiction: "US-NY",
                  ruleVersion: 1,
                },
                basis: null,
              },
        ]),
      ),
  } as unknown as CallRecordingConsentService;
}

export interface CallIntelligenceDoubles {
  db: Db;
  /** The organisation every tenant-scoped read asked for, in order. */
  orgsAsked: unknown[];
  cohort: CallAnalysisCohortService;
}

export function buildCohort(
  analyses: FixtureAnalysis[],
  calls: FixtureActivity[],
  options: {
    canReadTeam: boolean;
    members?: FixtureMember[];
    consent?: CallRecordingConsentService;
  },
): CallIntelligenceDoubles {
  const { db, orgsAsked } = makeCallIntelligenceDb(analyses, calls, options.members ?? []);
  const access = { holds: async () => options.canReadTeam };
  const visibility = new CallAnalysisVisibilityService(db, access as unknown as AccessService);
  const cohort = new CallAnalysisCohortService(
    db,
    visibility,
    options.consent ?? consentAllowing(),
  );
  return { db, orgsAsked, cohort };
}
