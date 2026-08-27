import { SignJWT } from "jose";
const ORG = "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const OWNER = "1ad20737-0838-4596-af1e-eba23318b786";
const secret = new TextEncoder().encode(process.env.BACKEND_JWT_SECRET);
async function token(sub, orgId) {
  return new SignJWT({ sub, orgId, sessionId: "s4-verify-" + Date.now() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("streamlineos-web").setAudience("streamlineos-api")
    .setIssuedAt().setExpirationTime("10m").sign(secret);
}
const t = await token(OWNER, ORG);
async function get(path, tok = t) {
  const r = await fetch("http://localhost:1500" + path, { headers: { Authorization: "Bearer " + tok } });
  const body = await r.text();
  return { status: r.status, body: body.slice(0, 220) };
}
for (const p of ["/build/9/tickets/key/1", "/build/9/tickets/key/101", "/build/9/tickets/key/3335", "/build/9/tickets/key/999999"]) {
  const r = await get(p);
  console.log(p.padEnd(34), r.status, r.body.replace(/\s+/g, " ").slice(0, 150));
}
