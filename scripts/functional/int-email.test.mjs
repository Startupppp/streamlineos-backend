import { mint, req, check, report } from "./harness.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL integration module — src/modules/email
// Routes (method + path + guard):
//   1. POST /notifications/dispatch            JwtAuthGuard + manual role gate (CEO|HR|ADMIN); body via dispatchSchema.parse()
//   2. POST /organization/invitations/resend   JwtAuthGuard + AbilityGuard  CheckAbility("manage","settings")
//   3. POST /settings/email-templates/test     JwtAuthGuard + AbilityGuard  CheckAbility("manage","settings:email-templates")
//
// SAFETY: external email provider resolves to Resend (RESEND_API_KEY set). We send
// AT MOST ONE real email — the [TEST] template to CONTACT_NOTIFICATION_EMAIL via the
// intended /settings/email-templates/test endpoint. Every other route is exercised
// on a NO-OP / not-found / validation / RBAC path that triggers zero external sends.
// Twilio (SMS/WhatsApp) is only probed via no-phone no-op paths — no real Twilio call.
// ─────────────────────────────────────────────────────────────────────────────

const CONTACT_EMAIL = process.env.CONTACT_NOTIFICATION_EMAIL;

const owner = await mint("owner");                                   // isOrgOwner -> manage:all, role OWNER
const member = await mint("member");                                 // no perms, role MEMBER
const adminRole = await mint("member", { role: "ADMIN" });           // passes dispatch role gate, but NO abilities
const hrRole = await mint("member", { role: "HR" });                 // also passes dispatch role gate
const settingsPerm = await mint("member", { permissions: ["settings:manage"] });
const templatesPerm = await mint("member", { permissions: ["settings:email-templates:manage"] });

const realCalls = [];

// =============================================================================
// ROUTE 1 — POST /notifications/dispatch
// =============================================================================

// 401 — no token
check("R1 no-token POST /notifications/dispatch -> 401", await req("POST", "/notifications/dispatch", { body: {} }), 401);

// RBAC negative — role gate only allows CEO|HR|ADMIN
check("R1 member POST /notifications/dispatch -> 403 (role gate)", await req("POST", "/notifications/dispatch", { token: member, body: { subject: "s", body: "b" } }), 403);
// owner has role OWNER which is NOT in {CEO,HR,ADMIN} -> intentionally denied
check("R1 owner POST /notifications/dispatch -> 403 (OWNER not in CEO|HR|ADMIN)", await req("POST", "/notifications/dispatch", { token: owner, body: { subject: "s", body: "b" } }), 403);

// Input validation — body parsed by dispatchSchema.parse() inside handler, caught by global ZodError filter -> 400
// (validation runs AFTER the role gate, so these MUST use an allowed role)
check("R1 admin missing subject -> 400", await req("POST", "/notifications/dispatch", { token: adminRole, body: { body: "hello" } }), 400);
check("R1 admin empty subject (min 1) -> 400", await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "", body: "hello" } }), 400);
check("R1 admin missing body -> 400", await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "s" } }), 400);
check("R1 admin invalid channel enum -> 400", await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "s", body: "b", channels: ["telegram"] } }), 400);
check("R1 admin empty channels array (min 1) -> 400", await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "s", body: "b", channels: [] } }), 400);
check("R1 admin invalid email format -> 400", await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "s", body: "b", email: "not-an-email", channels: ["email"] } }), 400);

// Graceful NO-OP paths (no external send): email channel w/o address, sms/whatsapp w/o phone
const noEmail = await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "s", body: "b", channels: ["email"] } });
check("R1 admin email-channel no address -> 200 (no-op)", noEmail, 200);
{
  const r = noEmail.body?.results ?? [];
  const ok = noEmail.body?.allFailed === true && r.length === 1 && r[0].channel === "email" && r[0].sent === false && r[0].reason === "no_email_address";
  check("R1 no-email no-op shape {sent:false, reason:no_email_address, allFailed:true}", { status: ok ? 200 : 599, body: noEmail.body }, 200);
}

const noPhoneSms = await req("POST", "/notifications/dispatch", { token: hrRole, body: { subject: "s", body: "b", channels: ["sms"] } });
check("R1 hr sms-channel no phone -> 200 (no-op)", noPhoneSms, 200);
{
  const r = noPhoneSms.body?.results ?? [];
  const ok = r.length === 1 && r[0].channel === "sms" && r[0].sent === false && r[0].reason === "no_phone_number";
  check("R1 no-phone sms no-op shape {sent:false, reason:no_phone_number}", { status: ok ? 200 : 599, body: noPhoneSms.body }, 200);
}

const noPhoneWa = await req("POST", "/notifications/dispatch", { token: adminRole, body: { subject: "s", body: "b", channels: ["whatsapp"] } });
check("R1 admin whatsapp-channel no phone -> 200 (no-op)", noPhoneWa, 200);
{
  const r = noPhoneWa.body?.results ?? [];
  const ok = r.length === 1 && r[0].channel === "whatsapp" && r[0].sent === false && r[0].reason === "no_phone_number";
  check("R1 no-phone whatsapp no-op shape", { status: ok ? 200 : 599, body: noPhoneWa.body }, 200);
}

// =============================================================================
// ROUTE 2 — POST /organization/invitations/resend
// =============================================================================

// 401 — no token
check("R2 no-token POST /organization/invitations/resend -> 401", await req("POST", "/organization/invitations/resend", { body: { invitationId: "x" } }), 401);

// RBAC negative — needs manage:settings
check("R2 member -> 403 (needs manage:settings)", await req("POST", "/organization/invitations/resend", { token: member, body: { invitationId: "x" } }), 403);
check("R2 admin-role (no abilities) -> 403", await req("POST", "/organization/invitations/resend", { token: adminRole, body: { invitationId: "x" } }), 403);

// Input validation — ZodValidationPipe (manage:settings holder reaches the pipe)
check("R2 settings-perm empty body -> 400", await req("POST", "/organization/invitations/resend", { token: settingsPerm, body: {} }), 400);
check("R2 settings-perm empty invitationId (min 1) -> 400", await req("POST", "/organization/invitations/resend", { token: settingsPerm, body: { invitationId: "" } }), 400);

// Graceful not-found — valid auth + non-existent invitation -> 404, sends NO email.
check("R2 owner unknown invitation -> 404 (no send)", await req("POST", "/organization/invitations/resend", { token: owner, body: { invitationId: "fn-test-nonexistent-invitation-id" } }), 404);
// RBAC-positive (non-owner) lands on 404 not 403 -> proves the ability gate passes for a settings:manage holder, still no send.
check("R2 settings-perm unknown invitation -> 404 (ability passes, no send)", await req("POST", "/organization/invitations/resend", { token: settingsPerm, body: { invitationId: "fn-test-nonexistent-invitation-id" } }), 404);

// =============================================================================
// ROUTE 3 — POST /settings/email-templates/test   (the ONE real-send endpoint)
// =============================================================================

// 401 — no token
check("R3 no-token POST /settings/email-templates/test -> 401", await req("POST", "/settings/email-templates/test", { body: { templateId: "auth.welcome", testEmail: "a@b.com" } }), 401);

// RBAC negative — needs manage:settings:email-templates
check("R3 member -> 403 (needs manage:settings:email-templates)", await req("POST", "/settings/email-templates/test", { token: member, body: { templateId: "auth.welcome", testEmail: "a@b.com" } }), 403);
check("R3 admin-role (no abilities) -> 403", await req("POST", "/settings/email-templates/test", { token: adminRole, body: { templateId: "auth.welcome", testEmail: "a@b.com" } }), 403);
// a plain settings:manage holder lacks the more specific settings:email-templates ability -> 403
check("R3 settings:manage (wrong specific ability) -> 403", await req("POST", "/settings/email-templates/test", { token: settingsPerm, body: { templateId: "auth.welcome", testEmail: "a@b.com" } }), 403);

// Input validation
check("R3 owner missing templateId -> 400", await req("POST", "/settings/email-templates/test", { token: owner, body: { testEmail: "a@b.com" } }), 400);
check("R3 owner invalid testEmail -> 400", await req("POST", "/settings/email-templates/test", { token: owner, body: { templateId: "auth.welcome", testEmail: "not-an-email" } }), 400);
check("R3 owner empty templateId (min 1) -> 400", await req("POST", "/settings/email-templates/test", { token: owner, body: { templateId: "", testEmail: "a@b.com" } }), 400);

// Graceful unknown-template — valid body, unknown id -> 404, sends NO email.
check("R3 owner unknown templateId -> 404 (no send)", await req("POST", "/settings/email-templates/test", { token: owner, body: { templateId: "does.not.exist", testEmail: "a@b.com" } }), 404);
// RBAC-positive (non-owner) with correct specific ability lands on 404 not 403, still no send.
check("R3 templates-perm unknown templateId -> 404 (ability passes, no send)", await req("POST", "/settings/email-templates/test", { token: templatesPerm, body: { templateId: "does.not.exist", testEmail: "a@b.com" } }), 404);

// ── THE ONE REAL EXTERNAL CALL: send a single [TEST] template to CONTACT_NOTIFICATION_EMAIL ──
if (CONTACT_EMAIL) {
  realCalls.push(`Resend email send (provider=resend) -> [TEST] auth.welcome to ${CONTACT_EMAIL} via POST /settings/email-templates/test`);
  const real = await req("POST", "/settings/email-templates/test", { token: owner, body: { templateId: "auth.welcome", testEmail: CONTACT_EMAIL } });
  check("R3 owner REAL send auth.welcome -> 200 (no 500 on happy path)", real, 200);
  const ok = real.body?.sent === true && real.body?.to === CONTACT_EMAIL && real.body?.templateId === "auth.welcome";
  check("R3 real-send response shape {sent:true, to, templateId}", { status: ok ? 200 : 599, body: real.body }, 200);
} else {
  console.log("  SKIP real send: CONTACT_NOTIFICATION_EMAIL not in env");
}

console.log("\nREAL EXTERNAL CALLS TRIGGERED:");
for (const c of realCalls) console.log("  - " + c);
if (realCalls.length === 0) console.log("  (none)");

process.exit(report("int-email") ? 0 : 1);
