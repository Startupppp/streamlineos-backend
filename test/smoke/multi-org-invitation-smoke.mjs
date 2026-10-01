/**
 * Ticket 06 — one account in two organisations, against a RUNNING API and a real
 * database. Every step is an HTTP request the product itself makes, and every
 * assertion is read back from the database, because the properties that matter
 * here (one account, two memberships, an allowlist that belongs to one tenant)
 * are database properties that a mocked suite cannot observe.
 *
 * It also smokes ticket 08's first-visit leave-policy offer on the same two
 * organisations, where "permanent for that organisation" needs a second
 * organisation to mean anything.
 *
 * Run it against a scratch database and a backend booted on it:
 *
 *   node --env-file=<scratch env> ./node_modules/@nestjs/cli/bin/nest.js start --builder swc
 *   API=http://localhost:1502 SMOKE_ENV_FILE=<scratch env> \
 *     node test/smoke/multi-org-invitation-smoke.mjs
 *
 * It seeds its own two organisations, placement rows and sessions, and tears
 * them down afterwards. NEVER point it at a shared database: it writes, and its
 * teardown lifts the append-only trigger on `audit_logs` to remove its own rows.
 */
import { createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import postgresFactory from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API = process.env.API ?? "http://localhost:1502";
const ENV_FILE = process.env.SMOKE_ENV_FILE ?? resolve(import.meta.dirname, "../../.env");
const ENV = Object.fromEntries(
  readFileSync(ENV_FILE, "utf8")
    .split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }),
);
if (/neon\.tech|amazonaws\.com/.test(ENV.DATABASE_URL ?? ""))
  throw new Error("[smoke] refusing to run against a hosted database — point SMOKE_ENV_FILE at a scratch one");

const sql = postgresFactory(ENV.DATABASE_URL, { prepare: false, max: 4 });

const RUN = randomUUID().slice(0, 8);
const orgA = `qa-mo-a-${RUN}`;
const orgB = `qa-mo-b-${RUN}`;
const ownerA = `qa-mo-owner-a-${RUN}`;
const ownerB = `qa-mo-owner-b-${RUN}`;
const joinerEmail = `joiner.${RUN}@allowed.test`;
const outsiderEmail = `outsider.${RUN}@blocked.test`;

const results = [];
const tokenOf = (joinUrl) => String(joinUrl).split("/").pop();
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

// Accepting requires the emailed one-time code (d08d62130). The smoke cannot read
// the email, so after the real request-otp call it plants a code it knows. The
// request-otp status is what matters: in production the frontend shipped this call
// ahead of the backend route and every accept answered
// `Cannot POST /organization/invitations/request-otp` (BUG-HRMS-010). A stack with
// no email transport answers 503 (the route ran, the send did not), so the planted
// code is inserted rather than rewritten — the service burns its own on a failed send.
const ROUTED = new Set([200, 503]);
const KNOWN_OTP = "424242";
const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");
async function acceptInvitation(joinUrl, names) {
  const token = tokenOf(joinUrl);
  const otp = await fetch(`${API}/organization/invitations/request-otp`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (ROUTED.has(otp.status)) {
    await sql`
      insert into invitation_email_otps (invitation_id, code_hash, expires_at)
      select id, ${sha256(KNOWN_OTP)}, now() + interval '10 minutes'
      from invitations where token_hash = ${sha256(token)}`;
  }
  const res = await fetch(`${API}/organization/invitations/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...names, emailOtp: KNOWN_OTP }),
  });
  return { otpStatus: otp.status, res };
}

async function seedOrg(org, owner) {
  await sql.begin(async (tx) => {
    await tx`insert into users (id, email, name, is_active, email_verified) values (${owner}, ${`${owner}@example.test`}, ${"QA Owner"}, true, now())`;
    const [seq] = await tx`select nextval(pg_get_serial_sequence('organization_members','id'))::int as id`;
    const membershipId = Number(seq.id);
    await tx`insert into organizations (id, name, slug, owner_membership_id, region) values (${org}, ${`QA MultiOrg ${org.slice(-8)}`}, ${org}, ${membershipId}, ${"primary"})`;
    await tx`insert into organization_members (id, org_id, user_id, role, status, is_owner) values (${membershipId}, ${org}, ${owner}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)`;
    await tx`
      insert into organization_placement
        (organization_id, region, cell_id, database_shard, object_storage_region, search_cluster, write_fence_token, lease_expires_at, status)
      values (${org}, ${"primary"}, ${"legacy-1"}, ${"primary"}, ${"auto"}, ${"primary"}, ${randomUUID()}, ${new Date(Date.now() + 86400_000)}, ${"ACTIVE"})
    `;
    await tx`insert into org_modules (org_id, module_key, enabled) values (${org}, ${"hr"}, true)`;
    // The per-org ladder role a module standing resolves to; boot seeding runs for
    // real organisations, not for rows inserted behind its back.
    await tx`insert into roles (name, slug, org_id, is_system, module_key, rank) values (${"HR Module Member"}, ${"HR_MODULE_MEMBER"}, ${org}, true, ${"hr"}, 40)`;
  });
}

async function openSession(userId) {
  const sessionId = randomUUID();
  await sql`insert into user_sessions (id, user_id, expires_at, is_revoked) values (${sessionId}, ${userId}, ${new Date(Date.now() + 3600_000)}, false)`;
  return sessionId;
}

async function exchange(userId, sessionId, orgId) {
  const proof = await new SignJWT({ sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("streamlineos-web-session-proof")
    .setAudience("streamlineos-api-exchange")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(new TextEncoder().encode(ENV.NEXTAUTH_SECRET));

  const res = await fetch(`${API}/auth/session-exchange`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": ENV.INTERNAL_API_SECRET,
      "x-session-proof": proof,
    },
    body: JSON.stringify({ orgId }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, token: body?.data?.token ?? body?.token, body };
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed?.data ?? parsed };
}

try {
  await seedOrg(orgA, ownerA);
  await seedOrg(orgB, ownerB);
  const sessionA = await openSession(ownerA);
  const sessionB = await openSession(ownerB);
  const exA = await exchange(ownerA, sessionA, orgA);
  const exB = await exchange(ownerB, sessionB, orgB);
  const tokenA = exA.token;
  const tokenB = exB.token;
  check("owners exchange a backend token for their own organisation", Boolean(tokenA && tokenB), `A=${exA.status} ${JSON.stringify(exA.body).slice(0,200)}`);

  // Organisation B restricts joining to one domain; A does not.
  await sql`insert into organization_allowed_email_domains (org_id, domain) values (${orgB}, ${"allowed.test"})`;

  const inviteA = await api(tokenA, "POST", "/users/invite", { email: joinerEmail, role: "MEMBER" });
  const inviteB = await api(tokenB, "POST", "/users/invite", { email: joinerEmail, role: "MEMBER" });
  check("the same address can be invited to both organisations", inviteA.status < 300 && inviteB.status < 300, `A=${inviteA.status} B=${inviteB.status}`);

  const blocked = await api(tokenB, "POST", "/users/invite", { email: outsiderEmail, role: "MEMBER" });
  const allowedElsewhere = await api(tokenA, "POST", "/users/invite", { email: outsiderEmail, role: "MEMBER" });
  check("an allowlist applies only to the organisation that set it", blocked.status >= 400 && allowedElsewhere.status < 300, `B=${blocked.status} A=${allowedElsewhere.status}`);

  const idA = inviteA.body?.invitationId ?? inviteA.body?.id;
  const idB = inviteB.body?.invitationId ?? inviteB.body?.id;
  const linkA = await api(tokenA, "POST", `/users/invitations/${idA}/join-link`);
  const linkB = await api(tokenB, "POST", `/users/invitations/${idB}/join-link`);
  check("a copied join link is reissued for both organisations", Boolean(linkA.body?.joinUrl && linkB.body?.joinUrl), `A=${linkA.status} B=${linkB.status}`);

  const { otpStatus: otpA, res: acceptA } = await acceptInvitation(linkA.body.joinUrl, { firstName: "Joiner", lastName: "QA" });
  check("request-otp is routed for a pending invitation (BUG-HRMS-010)", ROUTED.has(otpA), `status=${otpA}`);
  const acceptABody = await acceptA.json().catch(() => ({}));
  check("the first organisation accepts the invitation", acceptA.status < 300, `status=${acceptA.status} ${JSON.stringify(acceptABody).slice(0, 200)}`);

  const { otpStatus: otpB, res: acceptB } = await acceptInvitation(linkB.body.joinUrl, { firstName: "Joiner", lastName: "QA" });
  check("an existing account is asked for a code too", ROUTED.has(otpB), `status=${otpB}`);
  const acceptBBody = await acceptB.json().catch(() => ({}));
  check("an existing account joins the second organisation", acceptB.status < 300, `status=${acceptB.status} ${JSON.stringify(acceptBBody).slice(0, 200)}`);

  const accounts = await sql`select id from users where email = ${joinerEmail}`;
  check("joining twice creates exactly one account", accounts.length === 1, `accounts=${accounts.length}`);

  const memberships = await sql`
    select m.org_id, m.status, m.role from organization_members m
    join users u on u.id = m.user_id
    where u.email = ${joinerEmail} order by m.org_id`;
  check("the account holds one live membership in each organisation",
    memberships.length === 2 && memberships.every((m) => m.status === "ACTIVE"),
    JSON.stringify(memberships));

  const { res: replay } = await acceptInvitation(linkB.body.joinUrl, { firstName: "Joiner", lastName: "QA" });
  check("replaying an accepted invitation does not create a second membership", replay.status >= 400, `status=${replay.status}`);

  const joiner = accounts[0]?.id;
  if (!joiner) throw new Error("no joiner account to continue with");
  const joinerSession = await openSession(joiner);
  const joinerA = await exchange(joiner, joinerSession, orgA);
  const joinerB = await exchange(joiner, joinerSession, orgB);
  check("one session exchanges a token for either organisation", Boolean(joinerA.token && joinerB.token), `A=${joinerA.status} B=${joinerB.status}`);

  const accessA = await api(joinerA.token, "GET", "/me/access");
  const accessB = await api(joinerB.token, "GET", "/me/access");
  check("each token resolves access in its own organisation", accessA.status === 200 && accessB.status === 200, `A=${accessA.status} B=${accessB.status}`);
  check("the two tokens are not interchangeable identities",
    accessA.body?.membershipId !== accessB.body?.membershipId,
    `A=${accessA.body?.membershipId} B=${accessB.body?.membershipId}`);

  // The same account, reading the same endpoint, with only the organisation the
  // token names changing. Positive and negative together (BE-141): each list
  // must hold that organisation's owner and must not hold the other's.
  // Read as each organisation's administrator: the joiner is a MEMBER and has no
  // members-list permission, which would make an empty list prove nothing.
  const membersA = await api(tokenA, "GET", "/users?limit=50");
  const membersB = await api(tokenB, "GET", "/users?limit=50");
  const emailsIn = (payload) => {
    const rows = Array.isArray(payload) ? payload : (payload?.data ?? payload?.users ?? payload?.items ?? []);
    return (Array.isArray(rows) ? rows : []).map((row) => row.email);
  };
  check("a members read returns this organisation's people, including the shared account",
    emailsIn(membersA.body).includes(`${ownerA}@example.test`) &&
      emailsIn(membersB.body).includes(`${ownerB}@example.test`) &&
      emailsIn(membersA.body).includes(joinerEmail) &&
      emailsIn(membersB.body).includes(joinerEmail),
    `A=${JSON.stringify(emailsIn(membersA.body))} B=${JSON.stringify(emailsIn(membersB.body))}`);
  check("and none of the other organisation's",
    !emailsIn(membersA.body).includes(`${ownerB}@example.test`) &&
      !emailsIn(membersB.body).includes(`${ownerA}@example.test`));

  // An export is a background job carrying the requester's scope; one started in
  // A must not be readable with B's token.
  const exportA = await api(tokenA, "POST", "/hr/export/jobs", { filters: {} });
  if (exportA.status < 300 && exportA.body?.id) {
    const readAsB = await api(tokenB, "GET", `/hr/export/jobs/${exportA.body.id}`);
    check("an export job is unreachable from the other organisation's token", readAsB.status === 404, `status=${readAsB.status}`);
  } else {
    check("an export job is unreachable from the other organisation's token", false, `could not start an export: ${exportA.status} ${JSON.stringify(exportA.body).slice(0, 160)}`);
  }

  // Decline, resend and expiry, on a third address so the accepted state above
  // is left untouched.
  const declineEmail = `decliner.${RUN}@allowed.test`;
  const declined = await api(tokenB, "POST", "/users/invite", { email: declineEmail, role: "MEMBER" });
  const declineLink = await api(tokenB, "POST", `/users/invitations/${declined.body?.invitationId ?? declined.body?.id}/join-link`);
  const declineRes = await fetch(`${API}/organization/invitations/decline`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenOf(declineLink.body.joinUrl) }),
  });
  check("an invitation can be declined", declineRes.status < 300, `status=${declineRes.status}`);
  const declinedRows = await sql`select status from invitations where email = ${declineEmail}`;
  check("a declined invitation leaves no membership and no account",
    declinedRows.every((row) => row.status === "DECLINED") &&
      (await sql`select id from users where email = ${declineEmail}`).length === 0,
    JSON.stringify(declinedRows));

  // BUG-HRMS-003: a bulk invite carries module standings to every row it creates.
  const bulkEmails = [`bulk1.${RUN}@allowed.test`, `bulk2.${RUN}@allowed.test`];
  const bulk = await api(tokenB, "POST", "/users/bulk-invite", {
    emails: bulkEmails, role: "MEMBER", moduleAccess: [{ moduleKey: "hr", standing: "MEMBER" }],
  });
  const bulkAccess = await sql`
    select i.email, a.module_key, a.standing from invitation_module_access a
    join invitations i on i.id = a.invitation_id
    where i.email in ${sql(bulkEmails)} order by i.email`;
  check("a bulk invite stores the module standing on every invitation",
    bulk.status < 300 && bulkAccess.length === 2 && bulkAccess.every((r) => r.module_key === "hr" && r.standing === "MEMBER"),
    `status=${bulk.status} ${JSON.stringify(bulk.body).slice(0, 200)} rows=${JSON.stringify(bulkAccess)}`);

  const resendEmail = `resend.${RUN}@allowed.test`;
  const resendInvite = await api(tokenB, "POST", "/users/invite", { email: resendEmail, role: "MEMBER" });
  const resendId = resendInvite.body?.invitationId ?? resendInvite.body?.id;
  const resent = await api(tokenB, "POST", `/users/invitations/${resendId}/resend`);
  check("an invitation can be resent", resent.status < 300, `status=${resent.status}`);
  const afterResend = await sql`select count(*)::int as n from invitations where email = ${resendEmail}`;
  check("a resend reissues one invitation rather than adding another", afterResend[0]?.n === 1, `rows=${afterResend[0]?.n}`);

  // Expire it behind the product's back and prove the link stops working.
  const expiredLink = await api(tokenB, "POST", `/users/invitations/${resendId}/join-link`);
  await sql`update invitations set expires_at = now() - interval '1 day' where id = ${resendId}`;
  const { otpStatus: expiredOtp, res: expiredAccept } = await acceptInvitation(expiredLink.body.joinUrl, { firstName: "Late", lastName: "QA" });
  check("an expired invitation is sent no code", expiredOtp === 404, `status=${expiredOtp}`);
  check("an expired invitation is refused", expiredAccept.status >= 400, `status=${expiredAccept.status}`);
  check("and creates no account", (await sql`select id from users where email = ${resendEmail}`).length === 0);

  // Ticket 08's first-visit offer, over HTTP, on these same two organisations.
  const offerA = await api(tokenA, "GET", "/hr/leave-policies/templates");
  check("a new organisation is offered the leave-policy templates",
    offerA.status === 200 && offerA.body?.shouldOffer === true && offerA.body?.templates?.length === 3,
    `status=${offerA.status} shouldOffer=${offerA.body?.shouldOffer}`);

  const imported = await api(tokenA, "POST", "/hr/leave-policies/templates/import", {
    items: (offerA.body?.templates ?? []).map((template) => ({
      key: template.key,
      leaveTypeName: template.leaveTypeName,
      policyName: template.policyName,
      daysPerYear: template.daysPerYear,
      carryForward: template.carryForward,
      accrualType: template.accrualType,
      accrualRate: template.accrualRate,
      ...(template.maxBalance === null ? {} : { maxBalance: template.maxBalance }),
      carryForwardDays: template.carryForwardDays,
      encashable: template.encashable,
      probationRestricted: template.probationRestricted,
      effectiveFrom: "2026-04-01",
    })),
  });
  check("importing the templates creates the policies", imported.status < 300 && imported.body?.created === 3,
    `status=${imported.status} ${JSON.stringify(imported.body).slice(0, 160)}`);

  const afterImport = await api(tokenA, "GET", "/hr/leave-policies/templates");
  check("and the offer stops applying once policies exist", afterImport.body?.shouldOffer === false);

  const dismissB = await api(tokenB, "POST", "/hr/leave-policies/templates/dismiss");
  const offerBAfter = await api(tokenB, "GET", "/hr/leave-policies/templates");
  check("a refusal in one organisation is permanent there",
    dismissB.status === 200 && offerBAfter.body?.shouldOffer === false && offerBAfter.body?.dismissedAt !== null,
    `dismiss=${dismissB.status} dismissedAt=${offerBAfter.body?.dismissedAt}`);
  check("and does not refuse it for the other organisation",
    (await api(tokenA, "GET", "/hr/leave-policies/templates")).body?.dismissedAt === null);

  const outsider = await sql`select id from users where email = ${outsiderEmail}`;
  check("a refused invitation created no account", outsider.length === 0, `accounts=${outsider.length}`);
} catch (error) {
  check("smoke completed without an unexpected error", false, String(error).slice(0, 400));
} finally {
  // Let any post-commit audit write land before tearing down.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  // audit_logs is FORCE RLS, so even the owner needs row security off to see
  // the rows; and its org_id FK is ON DELETE NO ACTION, so it goes first.
  // audit_logs is append-only (a trigger refuses DELETE) and FORCE RLS, and its
  // org_id FK is ON DELETE NO ACTION. In this throwaway database the trigger is
  // lifted for the teardown only.
  await sql.begin(async (tx) => {
    await tx`set local row_security = off`;
    await tx`alter table audit_logs disable trigger user`;
    await tx`delete from audit_logs where org_id in (${orgA}, ${orgB})`;
    await tx`alter table audit_logs enable trigger user`;
    await tx`delete from organizations where id in (${orgA}, ${orgB})`;
  }).catch((error) => process.stdout.write(`teardown: ${String(error).slice(0, 160)}\n`));
  await sql`delete from users where email like ${`%.${RUN}@allowed.test`} or email like ${`%.${RUN}@blocked.test`} or email in (${`${ownerA}@example.test`}, ${`${ownerB}@example.test`})`;
  await sql.end({ timeout: 5 });
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
