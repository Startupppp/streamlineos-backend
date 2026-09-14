import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SignJWT } from "./../../node_modules/jose/dist/node/esm/index.js";
import postgres from "./../../node_modules/postgres/src/index.js";

const ENV_FILE = "D:/agent-work/disposable.env";
const BACKEND = "http://127.0.0.1:1500";
const USER_ID = "bbbbbbbb-9999-0000-0000-000000000002";
const SCRATCH_URL = "postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable";

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

async function main() {
  const env = parseEnvFile(ENV_FILE);
  const sql = postgres(SCRATCH_URL, { max: 1, prepare: false, onnotice: () => {} });
  const sessionId = randomUUID();

  try {
    const orgRows = await sql`
      SELECT org_id FROM organization_members
      WHERE user_id = ${USER_ID} AND status = 'ACTIVE'
      LIMIT 1`;
    if (orgRows.length === 0) {
      console.error("No active membership for user-9999");
      process.exit(1);
    }
    const orgId = orgRows[0].org_id;
    console.log(`orgId: ${orgId}`);

    await sql`INSERT INTO user_sessions (id, user_id, is_revoked, expires_at) VALUES (${sessionId}, ${USER_ID}, false, now() + interval '1 hour')`;

    const proof = await new SignJWT({ sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuer("streamlineos-web-session-proof")
      .setAudience("streamlineos-api-exchange")
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(env.NEXTAUTH_SECRET));

    const exchangeRes = await fetch(`${BACKEND}/auth/session-exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.INTERNAL_API_SECRET,
        "x-session-proof": proof,
      },
      body: JSON.stringify({ orgId }),
    });
    if (exchangeRes.status !== 200) {
      const errBody = await exchangeRes.text();
      console.error(`session-exchange returned ${exchangeRes.status}: ${errBody.slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
    const payload = await exchangeRes.json();
    const token = payload?.data?.token ?? payload?.token;
    if (!token) {
      console.error("No token returned from session-exchange");
      process.exitCode = 1;
      return;
    }
    console.log("session-exchange: PASS (token minted)");

    const moduleRows = await sql`
      SELECT DISTINCT module_key FROM module_ownerships WHERE org_id = ${orgId} LIMIT 5`;
    const moduleKey = moduleRows[0]?.module_key ?? "crm";
    console.log(`Testing GET /module-access/${moduleKey}/members`);

    const rosterRes = await fetch(`${BACKEND}/module-access/${moduleKey}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rosterBody = await rosterRes.text();
    console.log(`GET /module-access/${moduleKey}/members → HTTP ${rosterRes.status}`);
    if (rosterRes.status >= 200 && rosterRes.status < 300) {
      const parsed = JSON.parse(rosterBody);
      const count = parsed?.data?.data?.length ?? parsed?.data?.length ?? "?";
      console.log(`PASS — HTTP ${rosterRes.status}, member count in response: ${count}`);
    } else {
      console.error(`FAIL — HTTP ${rosterRes.status}: ${rosterBody.slice(0, 400)}`);
      process.exitCode = 1;
    }
  } finally {
    await sql`DELETE FROM user_sessions WHERE id = ${sessionId}`;
    await sql.end();
    console.log("Cleanup: user_sessions row deleted.");
  }
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
