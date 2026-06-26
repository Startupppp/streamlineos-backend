import { mint, req, check, report } from "./harness.mjs";

const owner = await mint("owner");
const sales = await mint("salesRep");

check("no-token /leads -> 401", await req("GET", "/leads", {}), 401);
check("owner /me -> 200", await req("GET", "/me", { token: owner }), 200);
check("owner /leads -> 200", await req("GET", "/leads", { token: owner }), 200);
const leads = await req("GET", "/leads", { token: owner });
console.log("  owner /leads count:", Array.isArray(leads.body) ? leads.body.length : Array.isArray(leads.body?.data) ? leads.body.data.length : "shape:" + JSON.stringify(leads.body).slice(0, 80));
check("owner /deals -> 200", await req("GET", "/deals", { token: owner }), 200);
check("owner /hr/departments -> 200", await req("GET", "/hr/departments", { token: owner }), 200);
check("owner /accounting/accounts -> 200", await req("GET", "/accounting/accounts", { token: owner }), 200);
check("owner /hr/recruitment/candidates -> 200", await req("GET", "/hr/recruitment/candidates", { token: owner }), 200);
check("owner /search?q=test -> 200", await req("GET", "/search?q=test", { token: owner }), 200);
check("bad-id /leads/999999 -> 404", await req("GET", "/leads/999999", { token: owner }), [404, 400]);

process.exit(report("smoke") ? 0 : 1);
