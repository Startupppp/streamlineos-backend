import { argv, env, exit } from "node:process";

const args = new Map();
for (const a of argv.slice(2)) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    args.set(k, v ?? true);
  }
}

const WEB_BASE = (args.get("web") ?? env.WEB_BASE ?? "http://localhost:1000/api").replace(/\/$/, "");
const API_BASE = (args.get("api") ?? env.API_BASE ?? "http://localhost:1500").replace(/\/$/, "");
const TOKEN = args.get("token") ?? env.BACKEND_TOKEN ?? "";
const WRITE = args.has("write");
const LEAD_ID = args.get("leadId") ?? env.PARITY_LEAD_ID ?? "";
const API_KEY = args.get("apiKey") ?? env.PARITY_API_KEY ?? "";

const IGNORE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "lastContactedAt",
  "assignedAt",
  "slaDueAt",
  "thisMonth",
]);

if (!TOKEN) {
  console.error("Missing BACKEND_TOKEN. Provide --token=<jwt> or set BACKEND_TOKEN.");
  console.error("Obtain it from the web app's GET /api/auth/backend-token while signed in.");
  exit(2);
}

function isObject(v) {
  return typeof v === "object" && v !== null;
}

function deepDiff(a, b, path = "", diffs = []) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push(`${path || "root"}: array length ${a.length} != ${b.length}`);
      return diffs;
    }
    for (let i = 0; i < a.length; i++) {
      deepDiff(a[i], b[i], `${path}[${i}]`, diffs);
    }
    return diffs;
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORE_KEYS.has(k)) continue;
      deepDiff(a[k], b[k], path ? `${path}.${k}` : k, diffs);
    }
    return diffs;
  }
  if (a !== b) {
    const ax = JSON.stringify(a);
    const bx = JSON.stringify(b);
    if (ax !== bx) {
      diffs.push(`${path || "root"}: WEB=${ax} API=${bx}`);
    }
  }
  return diffs;
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { __parseError: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

const READ_ENDPOINTS = [
  { name: "GET /leads?limit=5", web: "/leads?limit=5", api: "/leads?limit=5" },
  { name: "GET /leads/board", web: "/leads/board", api: "/leads/board" },
  { name: "GET /leads/stats", web: "/leads/stats", api: "/leads/stats" },
];

if (LEAD_ID) {
  READ_ENDPOINTS.push({
    name: `GET /leads/${LEAD_ID}`,
    web: `/leads/${LEAD_ID}`,
    api: `/leads/${LEAD_ID}`,
  });
} else {
  console.log("No --leadId provided; skipping the single-lead read parity check.");
}

let failures = 0;

for (const ep of READ_ENDPOINTS) {
  const [web, api] = await Promise.all([getJson(WEB_BASE, ep.web), getJson(API_BASE, ep.api)]);

  if (web.status !== api.status) {
    failures++;
    console.log(`DIFF  ${ep.name}: status WEB=${web.status} API=${api.status}`);
    continue;
  }

  const diffs = deepDiff(web.body, api.body);
  if (diffs.length === 0) {
    console.log(`PASS  ${ep.name} (status ${web.status})`);
  } else {
    failures++;
    console.log(`DIFF  ${ep.name} (status ${web.status}):`);
    for (const d of diffs.slice(0, 20)) console.log(`        - ${d}`);
    if (diffs.length > 20) console.log(`        ... ${diffs.length - 20} more`);
  }
}

if (WRITE) {
  console.log("\n--write: round-tripping a create against the API, reading back via the WEB.");
  const payload = {
    name: `parity-smoke-${Date.now()}`,
    source: "other",
    priority: "WARM",
    notes: "created by parity-leads.mjs --write",
  };

  const createRes = await fetch(`${API_BASE}/leads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const createText = await createRes.text();
  let created;
  try {
    created = createText ? JSON.parse(createText) : null;
  } catch {
    created = null;
  }

  if (createRes.status !== 201 || !created?.id) {
    failures++;
    console.log(`DIFF  POST /leads (API): status ${createRes.status} body ${createText.slice(0, 200)}`);
  } else {
    const id = created.id;
    const back = await getJson(WEB_BASE, `/leads/${id}`);
    if (back.status === 200 && back.body?.id === id && back.body?.name === payload.name) {
      console.log(`PASS  POST /leads round-trip (API created id=${id}, visible via WEB read)`);
    } else {
      failures++;
      console.log(`DIFF  POST /leads round-trip: WEB read status ${back.status} body ${JSON.stringify(back.body).slice(0, 200)}`);
    }

    const del = await fetch(`${API_BASE}/leads/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log(`        cleanup: DELETE /leads/${id} -> ${del.status}`);
  }

  if (API_KEY) {
    const ingestRes = await fetch(`${API_BASE}/leads/ingest`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `parity-ingest-${Date.now()}` }),
    });
    const ingestText = await ingestRes.text();
    let ingested;
    try {
      ingested = ingestText ? JSON.parse(ingestText) : null;
    } catch {
      ingested = null;
    }
    if (ingestRes.status === 201 && ingested?.id) {
      const back = await getJson(WEB_BASE, `/leads/${ingested.id}`);
      if (back.status === 200 && back.body?.id === ingested.id) {
        console.log(`PASS  POST /leads/ingest round-trip (id=${ingested.id}, visible via WEB read)`);
      } else {
        failures++;
        console.log(`DIFF  POST /leads/ingest round-trip: WEB read status ${back.status}`);
      }
      const del = await fetch(`${API_BASE}/leads/${ingested.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      console.log(`        cleanup: DELETE /leads/${ingested.id} -> ${del.status}`);
    } else {
      failures++;
      console.log(`DIFF  POST /leads/ingest (API): status ${ingestRes.status} body ${ingestText.slice(0, 200)}`);
    }
  } else {
    console.log("No --apiKey provided; skipping the ingest round-trip.");
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} DIFF(S)`} — read parity ${failures === 0 ? "OK" : "FAILED"}.`);
exit(failures === 0 ? 0 : 1);
