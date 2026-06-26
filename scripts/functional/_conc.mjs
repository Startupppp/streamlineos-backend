import { mint, req } from "./harness.mjs";
const boss = await mint("owner", { role: "CEO" });
// Fire concurrent bursts like the test does (no delays, sequential-but-fast)
for (const mode of ["sequential-fast","concurrent-30"]) {
  const counts = {};
  if (mode === "sequential-fast") {
    for (let i=0;i<40;i++){
      try { const r = await req("GET","/hr/recruitment/candidates/1",{token:boss}); const k=r.status+(r.body?.error?" "+r.body.error:""); counts[k]=(counts[k]||0)+1; }
      catch(e){ const k="THROW "+(e.cause?.code||e.message); counts[k]=(counts[k]||0)+1; }
    }
  } else {
    const ps = Array.from({length:30}, async()=>{
      try { const r = await req("GET","/hr/recruitment/candidates/1",{token:boss}); return r.status+(r.body?.error?" "+r.body.error:""); }
      catch(e){ return "THROW "+(e.cause?.code||e.message); }
    });
    for (const k of await Promise.all(ps)) counts[k]=(counts[k]||0)+1;
  }
  console.log(mode, JSON.stringify(counts));
}
