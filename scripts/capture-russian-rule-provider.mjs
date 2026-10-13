import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CLASSICAL_LANGUAGE_RULES } from '../src/core/language-data/classical-rules.js';
const corpus=JSON.parse(await readFile(new URL('./fixtures/russian-rule-contract.json', import.meta.url),'utf8'));
const endpoint=new URL(process.argv[2]);
if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw new Error('Stress capture requires a localhost provider');
endpoint.pathname='/v2/check';
const startedAt=new Date().toISOString(), responses=Array(corpus.cases.length);let next=0, completed=0;
await Promise.all(Array.from({length:4},async()=>{
 while(next<corpus.cases.length){
  const index=next++,item=corpus.cases[index];
  try {
   const response=await fetch(endpoint,{method:'POST',body:new URLSearchParams({text:item.text,language:'ru-RU',level:'picky',enabledOnly:'true',enabledRules:CLASSICAL_LANGUAGE_RULES.ru.join(',')}),signal:AbortSignal.timeout(12000)});
   const data=await response.json();responses[index]={id:item.id,status:response.status,data};
  }catch(error){responses[index]={id:item.id,error:error.message};}
  completed++;
  if(completed%200===0)console.log(`Captured ${completed}/${responses.length}`);
 }
}));
const fixture={provider:'LanguageTool 6.6, localhost, all declared XML rules, picky, no AI rules',startedAt,finishedAt:new Date().toISOString(),corpusSha256:corpus.corpusSha256,enabledRules:CLASSICAL_LANGUAGE_RULES.ru,responses};
fixture.responsesSha256=createHash('sha256').update(JSON.stringify(responses)).digest('hex');
await writeFile('release/qa-smart-audit/russian-rule-provider.json',JSON.stringify(fixture,null,2)+'\n');
const validation=JSON.parse(await readFile(new URL('./fixtures/russian-rule-source-validation.json', import.meta.url),'utf8'));
const summary={cases:responses.length,httpErrors:responses.filter(r=>r.error||r.status!==200).length,matches:responses.reduce((n,r)=>n+(r.data?.matches?.length||0),0),positiveExamples:0,targetRuleDetected:0,unexpectedTargetOnControl:0};
for(let i=0;i<corpus.cases.length;i++){const item=corpus.cases[i],found=responses[i].data?.matches?.some(m=>m.rule?.id===item.ruleId);if(validation.cases[i].expected!=='no-target-error'){summary.positiveExamples++;if(found)summary.targetRuleDetected++;}else if(found)summary.unexpectedTargetOnControl++;}
console.log(JSON.stringify(summary));
await writeFile('release/qa-smart-audit/russian-rule-provider-summary.json',JSON.stringify(summary,null,2)+'\n');
