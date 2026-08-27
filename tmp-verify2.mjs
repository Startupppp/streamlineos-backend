import { SignJWT } from "jose";
const ORG = "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const OWNER = "1ad20737-0838-4596-af1e-eba23318b786";
const OTHER_ORG = "762942e0-8c2f-45fd-b57a-da971f4b465b";
const secret = new TextEncoder().encode(process.env.BACKEND_JWT_SECRET);
const token = (sub, orgId) => new SignJWT({ sub, orgId, sessionId: "s4-verify" })
  .setProtectedHeader({ alg: "HS256" }).setIssuer("streamlineos-web").setAudience("streamlineos-api")
  .setIssuedAt().setExpirationTime("10m").sign(secret);
const get = async (path, tok) => {
  const r = await fetch("http://localhost:1500" + path, { headers: { Authorization: "Bearer " + tok } });
  return { s: r.status, b: (await r.text()).replace(/\s+/g," ").slice(0,190) };
};
const mine = await token(OWNER, ORG);
const cross = await token(OWNER, OTHER_ORG);

console.log("== cross-tenant: same owner, DIFFERENT active org, asking for project 9's ticket ==");
for (const p of ["/build/9/tickets/key/3335", "/build/9/tickets/key/101"]) {
  const r = await get(p, cross); console.log(" ", p.padEnd(30), r.s, r.b.slice(0,110));
}
console.log("== no token ==");
const anon = await fetch("http://localhost:1500/build/9/tickets/key/3335");
console.log("  ", anon.status, (await anon.text()).slice(0,80));

console.log("== global search (c12-02) ==");
for (const q of ["seed", "ticket", "ac", "zzzznomatch", "O'Brien"]) {
  const r = await get("/search?q=" + encodeURIComponent(q), mine);
  console.log("  q=" + JSON.stringify(q).padEnd(14), r.s, r.b.slice(0,150));
}
