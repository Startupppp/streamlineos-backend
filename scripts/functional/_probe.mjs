import { mint, req } from "./harness.mjs";
const boss = await mint("owner", { role: "CEO" });
for (const q of ["", "?days=7", "?days=30", "?days=365", "?days=1"]) {
  const r = await req("GET", "/hr/recruitment/interviewer-performance"+q, { token: boss });
  console.log("perf"+q, "->", r.status, JSON.stringify(r.body).slice(0,120));
  await new Promise(r=>setTimeout(r,200));
}
// also availability which uses similar date handling
const a = await req("GET", "/hr/recruitment/interviewers/availability?date=2026-06-26", { token: boss });
console.log("availability ->", a.status, JSON.stringify(a.body).slice(0,120));
