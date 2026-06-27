import { mint, req, check, report } from "./harness.mjs";

const code = () => `FN${Date.now()}${Math.floor(Math.random() * 1e3)}`.slice(0, 20).toUpperCase();

async function main() {
  const owner = await mint("owner");
  const member = await mint("member");
  const hr = await mint("owner", { role: "HR", isOrgOwner: false, permissions: [] });
  const ceo = await mint("owner", { role: "CEO", isOrgOwner: false, permissions: [] });

  check("AUTH no-token POST /branches -> 401", await req("POST", "/branches", { body: { name: "FN Branch", code: code() } }), 401);

  check("RBAC POST /branches member -> 403", await req("POST", "/branches", { token: member, body: { name: "FN Branch", code: code() } }), 403);

  check("VALIDATION POST /branches empty body -> 400", await req("POST", "/branches", { token: owner, body: {} }), 400);
  check("VALIDATION POST /branches bad code -> 400", await req("POST", "/branches", { token: owner, body: { name: "FN Branch", code: "!!" } }), 400);
  check("VALIDATION POST /branches name no letter -> 400", await req("POST", "/branches", { token: owner, body: { name: "123", code: code() } }), 400);

  const created = await req("POST", "/branches", { token: hr, body: { name: "FN Test Branch", code: code() } });
  check("HAPPY POST /branches HR -> 201", created, 201);
  const id = created.body?.id;

  check("RBAC CEO passes gate POST /branches -> 201", await req("POST", "/branches", { token: ceo, body: { name: "FN Test Branch CEO", code: code() } }).then(async (r) => {
    if (r.status === 201 && r.body?.id != null) await req("DELETE", `/branches/${r.body.id}`, { token: owner });
    return r;
  }), 201);

  if (id != null) {
    check("CLEANUP DELETE /branches/:id -> 200", await req("DELETE", `/branches/${id}`, { token: owner }), 200);
  }

  process.exit(report("gap-branches") ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
