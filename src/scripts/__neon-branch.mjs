import { resolve } from "node:path";
import * as dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), ".env") });
const KEY = process.env.NEON_API_KEY;
const PROJECT = process.env.NEON_PROJECT_ID;
const API = "https://console.neon.tech/api/v2";
const h = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const action = process.argv[2];

async function api(path, init) {
  const r = await fetch(`${API}${path}`, { headers: h, ...init });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${t.slice(0, 400)}`);
  return t ? JSON.parse(t) : {};
}

if (action === "create") {
  const created = await api(`/projects/${PROJECT}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: { name: "coldboot-prd-verify" },
      endpoints: [{ type: "read_write" }],
    }),
  });
  const branchId = created.branch.id;
  for (let i = 0; i < 40; i++) {
    const b = await api(`/projects/${PROJECT}/branches/${branchId}`);
    if (b.branch.current_state === "ready") break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const roles = await api(`/projects/${PROJECT}/branches/${branchId}/roles`);
  const owner = roles.roles.find((r) => r.name === "neondb_owner") ?? roles.roles[0];
  const pw = await api(`/projects/${PROJECT}/branches/${branchId}/roles/${owner.name}/reveal_password`);
  const host = created.endpoints[0].host;
  console.log(JSON.stringify({ branchId, host, role: owner.name, password: pw.password }));
} else if (action === "delete") {
  await api(`/projects/${PROJECT}/branches/${process.argv[3]}`, { method: "DELETE" });
  console.log("deleted", process.argv[3]);
} else if (action === "list") {
  const b = await api(`/projects/${PROJECT}/branches`);
  console.log(b.branches.map((x) => `${x.id}  ${x.name}  ${x.current_state}`).join("\n"));
}
