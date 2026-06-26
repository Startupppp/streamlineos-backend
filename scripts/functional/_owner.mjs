import { mint, req } from "./harness.mjs";
const owner = await mint("owner"); // literal OWNER role, isOrgOwner=true, NO role override
const cid = 1;
const routes = [
  ["GET","/hr/recruitment/bgv-compliance"],
  ["GET","/hr/recruitment/portals"],
  ["GET","/hr/recruitment/reports/scheduled"],
  ["GET",`/hr/recruitment/candidates/${cid}/vault`],
  ["GET",`/hr/recruitment/candidates/${cid}/vault/access-logs`],
  ["GET",`/hr/recruitment/candidates/${cid}/offers`],
  ["GET","/hr/recruitment/scorecard-templates"],
  ["POST","/hr/recruitment/jobs", {}],     // ability-gated, bad body -> expect 400 (passes ability), not 403
  ["POST","/hr/recruitment/offer-letter", {}], // ability-gated, bad body -> 400 not 403
  ["PUT","/hr/recruitment/interviews/slas", {}], // role-gated, bad body -> 400 not 403
];
for (const [m,p,b] of routes) {
  const r = await req(m,p,{token:owner, body:b});
  console.log(`${m} ${p} -> ${r.status}${r.body?.error?" "+r.body.error:""}`);
  await new Promise(r=>setTimeout(r,120));
}
