import { mint, req } from "./harness.mjs";
const boss = await mint("owner");
for (let i=0;i<10;i++){
  try { const r = await req("GET","/hr/recruitment/candidates",{token:boss}); if (r.status===200){ console.log("UP after",i,"tries, len="+ (Array.isArray(r.body)?r.body.length:"?")); process.exit(0);} }
  catch(e){}
  await new Promise(r=>setTimeout(r,1500));
}
console.log("still down"); process.exit(1);
