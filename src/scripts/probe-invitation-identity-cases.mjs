/**
 * HTTP-layer proof of the six P10/P11 invitation identity cases.
 *
 * The mocked evidence lives in invitation-acceptance-recovery.spec.ts and
 * invitation-acceptance-insert-ordering.spec.ts. Neither races a real row lock,
 * neither can assert "exactly one membership exists afterwards", and neither
 * exercises POST /organization/invitations/accept as a controller. This does all
 * three, against a running API and a real PostgreSQL.
 *
 *   1 one account in two organizations           2 an invitation opened by another account
 *   3 an expired token                           4 a revoked token
 *   5 a globally suspended account               6 two concurrent new-account acceptances
 *
 * Every case also asserts the positive direction — a live, correctly addressed
 * invitation is still accepted — so "refused" cannot be satisfied by a server
 * that refuses everything.
 *
 * What this CANNOT prove: case 2 with a genuinely signed-in second account.
 * POST /organization/invitations/accept is `@Public()`, JwtAuthGuard returns
 * before it reads the header, and the handler takes no `@CurrentUser()`, so no
 * actor reaches the service. Minting a real session bearer needs
 * INTERNAL_API_SECRET and NEXTAUTH_SECRET (see verify-identity-session-journey.mjs),
 * which this probe deliberately does not take. Case 2 therefore asserts the
 * substance instead: the route refuses every client-named actor, admits only the
 * invited address, and leaves the other account's identity and memberships
 * untouched. A change that started reading an actor would fail it.
 *
 * Invitation tokens are seeded as hashes, so no email is ever sent. No token,
 * hash, address or name is printed.
 *
 *   INVITE_PROBE_BASE_URL=http://127.0.0.1:1600 \
 *   INVITE_PROBE_DATABASE_URL=postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable \
 *     node src/scripts/probe-invitation-identity-cases.mjs [--allow-remote]
 *   node src/scripts/probe-invitation-identity-cases.mjs --self-test
 *
 * Pass criteria: exit 0 and every line PASS. Exit 1 on any failure or refusal.
 */
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const LIVE_DAYS = 7;
const EXPIRED_DAYS = -7;
const COHERENT_REFUSALS = [404, 409];
const NOT_A_CREDENTIAL = "probe-not-a-credential";

const results = [];
let failures = 0;
let rateLimited = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
  return ok;
}

const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");

export function isCoherentRefusal(status) {
  return COHERENT_REFUSALS.includes(status);
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function resolveTargets(env, allowRemote) {
  const base = env["INVITE_PROBE_BASE_URL"];
  const db = env["INVITE_PROBE_DATABASE_URL"];
  if (!base) throw new Error("INVITE_PROBE_BASE_URL is required");
  if (!db) throw new Error("INVITE_PROBE_DATABASE_URL is required; DATABASE_URL is not a fallback");
  const baseHost = new URL(base).hostname;
  const dbHost = new URL(db).hostname;
  if (!allowRemote && !isLoopback(baseHost)) throw new Error(`refusing non-loopback API host ${baseHost}`);
  if (!allowRemote && !isLoopback(dbHost)) throw new Error(`refusing non-loopback database host ${dbHost}`);
  if (baseHost !== dbHost) throw new Error(`API host ${baseHost} and database host ${dbHost} differ`);
  return { base: base.replace(/\/$/, ""), db };
}

async function request(base, method, path, options) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
    ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status === 429) rateLimited += 1;
  const payload = parsed !== null && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  return {
    status: res.status,
    code: typeof parsed?.code === "string" ? parsed.code : null,
    ok: payload?.ok === true,
    hasAutoLogin: typeof payload?.autoLoginToken === "string" && payload.autoLoginToken.length > 0,
    email: typeof payload?.email === "string" ? payload.email : null,
    userExists: typeof payload?.userExists === "boolean" ? payload.userExists : null,
  };
}

const accept = (base, body, headers) =>
  request(base, "POST", "/organization/invitations/accept", { body, headers });

const validateToken = (base, raw) =>
  request(base, "GET", `/organization/invitations/validate?token=${encodeURIComponent(raw)}`);

function selfTest() {
  const cases = [
    ["missing base url", {}, false],
    ["missing database url", { INVITE_PROBE_BASE_URL: "http://127.0.0.1:1600" }, false],
    [
      "DATABASE_URL is not a fallback",
      { INVITE_PROBE_BASE_URL: "http://127.0.0.1:1600", DATABASE_URL: "postgresql://x@127.0.0.1:5432/y" },
      false,
    ],
    [
      "loopback pair accepted",
      {
        INVITE_PROBE_BASE_URL: "http://127.0.0.1:1600",
        INVITE_PROBE_DATABASE_URL: "postgresql://u@127.0.0.1:5432/scratch_local",
      },
      true,
    ],
    [
      "remote refused without the flag",
      {
        INVITE_PROBE_BASE_URL: "https://api.example.com",
        INVITE_PROBE_DATABASE_URL: "postgresql://u@api.example.com:5432/p",
      },
      false,
    ],
    [
      "mismatched hosts refused",
      {
        INVITE_PROBE_BASE_URL: "http://127.0.0.1:1600",
        INVITE_PROBE_DATABASE_URL: "postgresql://u@10.0.0.5:5432/p",
      },
      false,
    ],
  ];
  for (const [label, env, shouldPass] of cases) {
    let passed = true;
    try {
      resolveTargets(env, false);
    } catch {
      passed = false;
    }
    check(label, passed, shouldPass);
  }

  let remoteAllowed = true;
  try {
    resolveTargets(
      {
        INVITE_PROBE_BASE_URL: "https://api.example.com",
        INVITE_PROBE_DATABASE_URL: "postgresql://u@api.example.com:5432/p",
      },
      true,
    );
  } catch {
    remoteAllowed = false;
  }
  check("remote allowed with --allow-remote", remoteAllowed, true);

  check(
    "the concurrent-loser predicate accepts 404 and 409 and rejects 200 and 500",
    [isCoherentRefusal(404), isCoherentRefusal(409), isCoherentRefusal(200), isCoherentRefusal(500)],
    [true, true, false, false],
  );
  check(
    "a token is hashed before it is stored",
    hashToken("probe") === createHash("sha256").update("probe").digest("hex") && hashToken("probe") !== "probe",
    true,
  );
}

async function main() {
  const allowRemote = process.argv.includes("--allow-remote");

  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log(results.join("\n"));
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const { base, db } = resolveTargets(process.env, allowRemote);
  const sql = postgres(db, { max: 6, prepare: false });
  const [{ d }] = await sql`select current_database() as d`;
  console.log(`api:      ${base}`);
  console.log(`database: ${d}\n`);

  const run = randomUUID().slice(0, 8);
  const orgIds = [];
  const invitationIds = [];
  const emails = [];

  function probeEmail(label) {
    const address = `s8-invite-${run}-${label}@probe.invalid`;
    emails.push(address);
    return address;
  }

  async function createUser(email, options) {
    const id = randomUUID();
    const firstName = options?.firstName ?? null;
    const lastName = options?.lastName ?? null;
    const name = [firstName, lastName].filter(Boolean).join(" ") || null;
    await sql`insert into users (id, email, name, first_name, last_name, is_active, email_verified, created_at, updated_at)
              values (${id}, ${email}, ${name}, ${firstName}, ${lastName}, ${options?.isActive ?? true}, now(), now(), now())`;
    return id;
  }

  async function createOrg(label) {
    const orgId = randomUUID();
    const ownerId = await createUser(probeEmail(`${label}-owner`));
    const [seq] = await sql`select nextval('organization_members_id_seq') as next_id`;
    const ownerMembershipId = Number(seq.next_id);
    await sql.begin(async (tx) => {
      await tx`insert into organizations (id, name, slug, status, region, owner_membership_id, created_at, updated_at)
               values (${orgId}, ${`S8 probe ${label}`}, ${`s8-probe-${run}-${label}`}, 'ACTIVE', 'primary',
                       ${ownerMembershipId}, now(), now())`;
      await tx`insert into organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
               values (${ownerMembershipId}, ${ownerId}, ${orgId}, 'OWNER', true, 'ACTIVE', now())`;
    });
    await sql`insert into organization_placement
                (organization_id, region, cell_id, database_shard, object_storage_region, search_cluster,
                 placement_version, write_fence_token, lease_expires_at, status, created_at, updated_at)
              values (${orgId}, 'primary', 'legacy-1', 'primary', 'primary', 'primary',
                      1, gen_random_uuid()::text, now() + interval '24 hours', 'ACTIVE', now(), now())
              on conflict (organization_id) do nothing`;
    orgIds.push(orgId);
    return { orgId, ownerId, ownerMembershipId };
  }

  async function createMembership(orgId, userId) {
    await sql`insert into organization_members (user_id, org_id, role, is_owner, status, joined_at)
              values (${userId}, ${orgId}, 'MEMBER', false, 'ACTIVE', now())`;
  }

  async function createInvitation(orgId, email, options) {
    const id = randomUUID();
    const raw = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
    const days = options?.days ?? LIVE_DAYS;
    const status = options?.status ?? "PENDING";
    await sql`insert into invitations (id, email, token_hash, org_id, role, expires_at, status, created_at)
              values (${id}, ${email}, ${hashToken(raw)}, ${orgId}, 'MEMBER',
                      now() + make_interval(days => ${days}::int), ${status}::invitation_status, now())`;
    invitationIds.push(id);
    return { id, raw };
  }

  async function userIdFor(email) {
    const [row] = await sql`select id from users where lower(email) = lower(${email}) limit 1`;
    return row?.id ?? null;
  }

  async function userCountFor(email) {
    const [row] = await sql`select count(*)::int n from users where lower(email) = lower(${email})`;
    return Number(row.n);
  }

  async function identityDigest(email) {
    const [row] = await sql`select id, email, name, first_name, last_name, email_verified, is_active, deleted_at
                            from users where lower(email) = lower(${email}) limit 1`;
    if (!row) return null;
    return createHash("sha256")
      .update(
        JSON.stringify([
          row.id,
          row.email,
          row.name,
          row.first_name,
          row.last_name,
          row.email_verified,
          row.is_active,
          row.deleted_at,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
  }

  async function membershipOrgIdsFor(userId) {
    if (!userId) return [];
    const rows = await sql`select org_id from organization_members where user_id = ${userId} order by org_id`;
    return rows.map((row) => row.org_id).sort();
  }

  async function membershipCount(orgId, userId) {
    if (!userId) return 0;
    const [row] = await sql`select count(*)::int n from organization_members
                            where org_id = ${orgId} and user_id = ${userId}`;
    return Number(row.n);
  }

  async function nonOwnerMembers(orgId) {
    const rows = await sql`select om.id, om.user_id, u.email from organization_members om
                           join users u on u.id = om.user_id
                           where om.org_id = ${orgId} and om.is_owner = false
                           order by om.id`;
    return rows;
  }

  async function projectedOrgIdsFor(userId) {
    if (!userId) return [];
    const rows = await sql`select org_id from account_organization_index where user_id = ${userId} order by org_id`;
    return rows.map((row) => row.org_id).sort();
  }

  async function invitationState(invitationId) {
    const [row] = await sql`select status, accepted_at, accepted_membership_id
                            from invitations where id = ${invitationId}`;
    return {
      status: row?.status ?? null,
      consumed: row?.accepted_at !== null && row?.accepted_at !== undefined,
      membershipId: row?.accepted_membership_id ?? null,
    };
  }

  async function seatCount(orgId) {
    const [row] = await sql`select ((select count(*)::int from organization_members
                                      where org_id = ${orgId} and status != 'LEFT')
                                  + (select count(*)::int from invitations
                                      where org_id = ${orgId} and status = 'PENDING'
                                        and accepted_at is null and expires_at > now()))::int as n`;
    return Number(row.n);
  }

  async function acceptedSeatEvents(orgId, invitationId) {
    const [row] = await sql`select count(*)::int n from billing_seat_events
                            where org_id = ${orgId} and subject_id = ${invitationId}
                              and event_type = 'INVITE_ACCEPTED'`;
    return Number(row.n);
  }

  async function suspensionState(email) {
    const [row] = await sql`select is_active, deleted_at from users where lower(email) = lower(${email}) limit 1`;
    return { isActive: row?.is_active ?? null, deleted: row?.deleted_at !== null && row?.deleted_at !== undefined };
  }

  try {
    // --- neuter: the endpoint is not blanket-accepting ---
    const junk = await accept(base, { token: randomUUID() });
    check("NEUTER an unknown token is refused 404", [junk.status, junk.code], [404, "NOT_FOUND"]);

    // --- case 1: one account in two organizations ---
    const org1 = await createOrg("c1-first");
    const org2 = await createOrg("c1-second");
    const sharedEmail = probeEmail("c1-account");
    const inv1 = await createInvitation(org1.orgId, sharedEmail);
    const inv2 = await createInvitation(org2.orgId, sharedEmail);

    const firstJoin = await accept(base, { token: inv1.raw, firstName: "Probe", lastName: "One" });
    check(
      "C1 a live, correctly addressed invitation is accepted",
      [firstJoin.status, firstJoin.ok, firstJoin.hasAutoLogin],
      [200, true, true],
    );
    const sharedUserId = await userIdFor(sharedEmail);
    const identityAfterFirst = await identityDigest(sharedEmail);

    const secondJoin = await accept(base, { token: inv2.raw, firstName: "Rewritten", lastName: "Elsewhere" });
    check(
      "C1 the same account is accepted into a second organization",
      [secondJoin.status, secondJoin.ok],
      [200, true],
    );
    check("C1 exactly one account exists for the invited address", await userCountFor(sharedEmail), 1);
    check(
      "C1 the account holds one membership in each organization, tenant-distinct",
      await membershipOrgIdsFor(sharedUserId),
      [org1.orgId, org2.orgId].sort(),
    );
    check(
      "C1 the second organization did not rewrite the global identity row",
      await identityDigest(sharedEmail),
      identityAfterFirst,
    );
    const [lastActive] = await sql`select last_active_org_id from users where id = ${sharedUserId}`;
    check("C1 only the active organization moved", lastActive.last_active_org_id, org2.orgId);
    check(
      "C1 the account-organization projection lists both organizations",
      await projectedOrgIdsFor(sharedUserId),
      [org1.orgId, org2.orgId].sort(),
    );
    const inv1State = await invitationState(inv1.id);
    const inv2State = await invitationState(inv2.id);
    check(
      "C1 both invitations are claimed exactly once",
      [inv1State.status, inv1State.consumed, inv2State.status, inv2State.consumed],
      ["ACCEPTED", true, "ACCEPTED", true],
    );

    // --- case 2: an invitation opened by another account ---
    const org3 = await createOrg("c2-invited");
    const otherEmail = probeEmail("c2-other-account");
    const otherUserId = await createUser(otherEmail, { firstName: "Other", lastName: "Account" });
    await createMembership(org2.orgId, otherUserId);
    const invitedEmail = probeEmail("c2-invited-address");
    const inv3 = await createInvitation(org3.orgId, invitedEmail);

    const namedEmail = await accept(base, { token: inv3.raw, email: otherEmail });
    check(
      "C2 naming another account's address in the body is refused 400",
      [namedEmail.status, namedEmail.code],
      [400, "VALIDATION_FAILED"],
    );
    const namedUser = await accept(base, { token: inv3.raw, userId: otherUserId });
    check(
      "C2 naming another account's id in the body is refused 400",
      [namedUser.status, namedUser.code],
      [400, "VALIDATION_FAILED"],
    );

    const validated = await validateToken(base, inv3.raw);
    check(
      "C2 validation reports the invited address and that no account holds it yet",
      [validated.status, validated.email === invitedEmail, validated.userExists],
      [200, true, false],
    );

    const otherIdentityBefore = await identityDigest(otherEmail);
    const otherOrgsBefore = await membershipOrgIdsFor(otherUserId);
    const openedByOther = await accept(
      base,
      { token: inv3.raw },
      {
        authorization: `Bearer ${NOT_A_CREDENTIAL}`,
        "x-user-id": otherUserId,
        "x-org-id": org2.orgId,
      },
    );
    check(
      "C2 the invitation is still accepted, so the route is not refusing everything",
      [openedByOther.status, openedByOther.ok],
      [200, true],
    );
    check("C2 the other account gained no membership in the invited organization", await membershipCount(org3.orgId, otherUserId), 0);
    const org3Members = await nonOwnerMembers(org3.orgId);
    check(
      "C2 the only admitted member is the invited address",
      [org3Members.length, org3Members[0]?.email === invitedEmail],
      [1, true],
    );
    check("C2 the other account's identity row is untouched", await identityDigest(otherEmail), otherIdentityBefore);
    check("C2 the other account's memberships are unchanged", await membershipOrgIdsFor(otherUserId), otherOrgsBefore);
    check(
      "C2 the other account was not projected into the invited organization",
      (await projectedOrgIdsFor(otherUserId)).includes(org3.orgId),
      false,
    );

    // --- case 3: an expired token ---
    const org4 = await createOrg("c3-expired");
    const expiredEmail = probeEmail("c3-account");
    const inv4 = await createInvitation(org4.orgId, expiredEmail, { days: EXPIRED_DAYS });

    const expiredAttempt = await accept(base, { token: inv4.raw });
    check("C3 an expired token is refused 404", [expiredAttempt.status, expiredAttempt.code], [404, "NOT_FOUND"]);
    const inv4AfterRefusal = await invitationState(inv4.id);
    check(
      "C3 the refused invitation is not consumed",
      [inv4AfterRefusal.status, inv4AfterRefusal.consumed, inv4AfterRefusal.membershipId],
      ["PENDING", false, null],
    );
    check("C3 no account was created for the expired invitation", await userCountFor(expiredEmail), 0);
    check("C3 no member was admitted", (await nonOwnerMembers(org4.orgId)).length, 0);

    await sql`update invitations set expires_at = now() + make_interval(days => ${LIVE_DAYS}::int) where id = ${inv4.id}`;
    const expiryMovedForward = await accept(base, { token: inv4.raw });
    check(
      "C3 the same token is accepted once only the expiry has moved forward",
      [expiryMovedForward.status, expiryMovedForward.ok],
      [200, true],
    );
    const inv4AfterAccept = await invitationState(inv4.id);
    check(
      "C3 the now-live invitation is claimed and admits exactly one member",
      [inv4AfterAccept.status, inv4AfterAccept.consumed, (await nonOwnerMembers(org4.orgId)).length],
      ["ACCEPTED", true, 1],
    );

    // --- case 4: a revoked token ---
    const org5 = await createOrg("c4-revoked");
    const revokedEmail = probeEmail("c4-account");
    const inv5 = await createInvitation(org5.orgId, revokedEmail);
    await sql`update invitations set status = 'REVOKED', revoked_at = now() where id = ${inv5.id}`;

    const revokedAttempt = await accept(base, { token: inv5.raw });
    check("C4 a revoked token is refused 404", [revokedAttempt.status, revokedAttempt.code], [404, "NOT_FOUND"]);
    const inv5AfterRefusal = await invitationState(inv5.id);
    check(
      "C4 a revoked invitation is never revived by an id-only update",
      [inv5AfterRefusal.status, inv5AfterRefusal.consumed, inv5AfterRefusal.membershipId],
      ["REVOKED", false, null],
    );
    check("C4 no account was created for the revoked invitation", await userCountFor(revokedEmail), 0);
    check("C4 no member was admitted", (await nonOwnerMembers(org5.orgId)).length, 0);

    await sql`update invitations set status = 'PENDING', revoked_at = null where id = ${inv5.id}`;
    const reinstated = await accept(base, { token: inv5.raw });
    check(
      "C4 the same token is accepted once only the status has been reinstated",
      [reinstated.status, reinstated.ok],
      [200, true],
    );
    const inv5AfterAccept = await invitationState(inv5.id);
    check(
      "C4 the reinstated invitation is claimed and admits exactly one member",
      [inv5AfterAccept.status, inv5AfterAccept.consumed, (await nonOwnerMembers(org5.orgId)).length],
      ["ACCEPTED", true, 1],
    );

    // --- case 5: a globally suspended account ---
    const org6 = await createOrg("c5-suspended");
    const suspendedEmail = probeEmail("c5-account");
    const suspendedUserId = await createUser(suspendedEmail, {
      isActive: false,
      firstName: "Suspended",
      lastName: "Account",
    });
    const inv6 = await createInvitation(org6.orgId, suspendedEmail);
    const suspendedIdentityBefore = await identityDigest(suspendedEmail);

    const suspendedAttempt = await accept(base, { token: inv6.raw });
    check("C5 a globally suspended account is refused 403", [suspendedAttempt.status, suspendedAttempt.code], [403, "FORBIDDEN"]);
    check("C5 the global suspension is not cleared as a side effect", await suspensionState(suspendedEmail), {
      isActive: false,
      deleted: false,
    });
    check("C5 the suspended account's identity row is untouched", await identityDigest(suspendedEmail), suspendedIdentityBefore);
    const inv6AfterRefusal = await invitationState(inv6.id);
    check(
      "C5 the refused invitation is not consumed",
      [inv6AfterRefusal.status, inv6AfterRefusal.consumed],
      ["PENDING", false],
    );
    check("C5 no membership was admitted for the suspended account", await membershipCount(org6.orgId, suspendedUserId), 0);

    await sql`update users set is_active = true where id = ${suspendedUserId}`;
    const restored = await accept(base, { token: inv6.raw });
    check(
      "C5 the same invitation is accepted once only the suspension has been lifted",
      [restored.status, restored.ok],
      [200, true],
    );
    check("C5 the restored account holds exactly one membership", await membershipCount(org6.orgId, suspendedUserId), 1);

    // --- case 6: two concurrent acceptances creating a new account ---
    const org7 = await createOrg("c6-concurrent");
    const raceEmail = probeEmail("c6-account");
    const inv7 = await createInvitation(org7.orgId, raceEmail);
    const seatsBefore = await seatCount(org7.orgId);

    const [raceA, raceB] = await Promise.all([accept(base, { token: inv7.raw }), accept(base, { token: inv7.raw })]);
    const winners = [raceA, raceB].filter((r) => r.status === 200);
    const losers = [raceA, raceB].filter((r) => r.status !== 200);
    check("C6 exactly one of two concurrent acceptances succeeds", [winners.length, winners[0]?.ok ?? null], [1, true]);
    check(
      "C6 neither concurrent acceptance returned a 5xx",
      [raceA.status < 500, raceB.status < 500],
      [true, true],
    );
    check(
      "C6 the loser gets a coherent refusal, not a server error",
      [
        losers.length,
        isCoherentRefusal(losers[0]?.status ?? 0),
        ["NOT_FOUND", "CONFLICT"].includes(losers[0]?.code ?? ""),
      ],
      [1, true, true],
    );

    const raceUserId = await userIdFor(raceEmail);
    check("C6 exactly one account was created", await userCountFor(raceEmail), 1);
    check("C6 exactly one membership was created", await membershipCount(org7.orgId, raceUserId), 1);
    check("C6 exactly one acceptance was recorded in the seat ledger", await acceptedSeatEvents(org7.orgId, inv7.id), 1);
    check("C6 the pending seat converted once and was never doubled", await seatCount(org7.orgId), seatsBefore);
    const raceMembers = await nonOwnerMembers(org7.orgId);
    const inv7State = await invitationState(inv7.id);
    check(
      "C6 the invitation is claimed once and points at that single membership",
      [inv7State.status, inv7State.consumed, inv7State.membershipId],
      ["ACCEPTED", true, raceMembers[0]?.id ?? null],
    );

    const followUpEmail = probeEmail("c6-follow-up");
    const inv8 = await createInvitation(org7.orgId, followUpEmail);
    const followUp = await accept(base, { token: inv8.raw });
    check(
      "C6 a further live invitation in the same organization is still accepted",
      [followUp.status, followUp.ok],
      [200, true],
    );
    check("C6 the organization now holds exactly two admitted members", (await nonOwnerMembers(org7.orgId)).length, 2);

    check("no request was rate limited", rateLimited, 0);
  } finally {
    const scrub = (query) => query.catch(() => undefined);
    for (const orgId of orgIds) {
      await scrub(sql`delete from notifications where org_id = ${orgId}`);
      await scrub(sql`delete from invitation_events where org_id = ${orgId}`);
      await scrub(sql`delete from billing_seat_events where org_id = ${orgId}`);
      await scrub(sql`delete from invitations where org_id = ${orgId}`);
      await scrub(sql`delete from role_assignments where org_id = ${orgId}`);
      await scrub(sql`delete from access_versions where org_id = ${orgId}`);
      await scrub(sql`delete from account_organization_index where org_id = ${orgId}`);
      await scrub(sql`delete from organization_members where org_id = ${orgId}`);
      await scrub(sql`delete from organization_placement where organization_id = ${orgId}`);
      await scrub(sql`update users set last_active_org_id = null where last_active_org_id = ${orgId}`);
      await scrub(sql`delete from organizations where id = ${orgId}`);
    }
    for (const email of emails) {
      await scrub(sql`delete from magic_link_tokens where user_id in (select id from users where lower(email) = lower(${email}))`);
      await scrub(sql`delete from account_organization_index where user_id in (select id from users where lower(email) = lower(${email}))`);
      await scrub(sql`delete from users where lower(email) = lower(${email})`);
    }

    let residualUsers = 0;
    for (const email of emails) {
      const [row] = await sql`select count(*)::int n from users where lower(email) = lower(${email})`;
      residualUsers += Number(row.n);
    }
    let residualOrgs = 0;
    let residualMembers = 0;
    for (const orgId of orgIds) {
      const [org] = await sql`select count(*)::int n from organizations where id = ${orgId}`;
      const [members] = await sql`select count(*)::int n from organization_members where org_id = ${orgId}`;
      residualOrgs += Number(org.n);
      residualMembers += Number(members.n);
    }
    let residualInvitations = 0;
    for (const invitationId of invitationIds) {
      const [row] = await sql`select count(*)::int n from invitations where id = ${invitationId}`;
      residualInvitations += Number(row.n);
    }
    check(
      "cleanup removed every account, organization, membership and invitation this probe created",
      [residualUsers, residualOrgs, residualMembers, residualInvitations],
      [0, 0, 0, 0],
    );
    await sql.end({ timeout: 5 });
  }

  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERR ${err.message}`);
  process.exit(1);
});
