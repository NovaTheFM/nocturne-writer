import { parseArgs } from 'node:util';
import { mkdir, open, readFile, writeFile, unlink, access, readdir } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platform, arch, cpus } from 'node:os';
import { PROJECT_CHECKS, ARTIFACT_CHECKS, EXTRA_CHECKS, DIAGNOSTIC_SCRIPTS } from './qa/checks.mjs';
import { availablePort, runCheck, archiveEvidence, sourceFingerprint, filesUnder, killOwnedProcess } from './qa/runner.mjs';
import { writeReports, reportStatus } from './qa/report.mjs';
import { featureInventory, featureObservation } from './qa/feature-inventory.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
const {values}=parseArgs({options:{platform:{type:'string',default:'all'},mode:{type:'string',default:'full'},artifacts:{type:'string',default:'auto'},'native-android':{type:'string',default:'auto'},trace:{type:'string',default:'failures'},seed:{type:'string',default:'20261004'},steps:{type:'string',default:'6'},repeat:{type:'string',default:'1'},only:{type:'string'},output:{type:'string'},'android-serial':{type:'string'},'fail-fast':{type:'boolean'},list:{type:'boolean'},help:{type:'boolean'}}});
if(values.help){console.log(`Nocturne App Tester
node scripts/test-app.mjs [options]
  --platform=all|desktop|android     Target (default all)
  --mode=smoke|full                 Depth (default full)
  --artifacts=auto|required|off     Verify existing EXE/APK; required reports gaps
  --native-android=auto|required|off  Real WebView, IME and Back via adb
  --android-serial=SERIAL           Select a test device
  --trace=failures|all|off          Trace retention; screenshots/logs always saved
  --seed=NUMBER --steps=NUMBER     Repeatable writing model, 1..30 operations
  --repeat=NUMBER                  Repeat selected checks, 1..10
  --only=ID,ID --fail-fast --list  Selection and execution
  --output=PATH                    Reports inside this workspace
No dependency installation, APK installation, app data clearing or network publication.`);process.exit(0);}
for(const[key,allowed]of [['platform',['all','desktop','android']],['mode',['smoke','full']],['artifacts',['auto','required','off']],['native-android',['auto','required','off']],['trace',['failures','all','off']]])if(!allowed.includes(values[key]))throw new Error(`Invalid --${key}: ${values[key]}`);
for(const[key,max]of [['steps',30],['repeat',10],['seed',4294967295]]){const number=Number(values[key]);if(!Number.isInteger(number)||number<(key==='seed'?0:1)||number>max)throw new Error(`Invalid --${key}`);values[key]=number;}
const options={...values,nativeAndroid:values['native-android']};
const all=[...PROJECT_CHECKS,...EXTRA_CHECKS,...ARTIFACT_CHECKS];
const only=values.only?.split(',');if(only)for(const id of only)if(!all.some(check=>check.id===id))throw new Error(`Unknown check: ${id}`);
let selected=all.filter(check=>(values.platform==='all'||check.platforms.includes(values.platform))&&(!only||only.includes(check.id))&&(only||check.modes.includes(values.mode)));
selected=selected.filter(check=>!check.artifact||values.artifacts!=='off').filter(check=>check.id!=='native-android'||values['native-android']!=='off');
if(!selected.length)throw new Error('No checks selected');
if(values.list){console.log(selected.map(check=>`${check.id}\t${check.platforms.join(',')}\t${check.areas.join(',')}`).join('\n'));process.exit(0);}

const qaRoot=resolve('release/qa'),testerRoot=join(qaRoot,'app-tester');await mkdir(testerRoot,{recursive:true});
const lockPath=join(testerRoot,'.active.lock');let lock;
try{lock=await open(lockPath,'wx');}catch(error){
  if(error.code!=='EEXIST')throw error;
  const existing=JSON.parse(await readFile(lockPath,'utf8'));let alive=true;try{process.kill(existing.pid,0);}catch(problem){if(problem.code==='ESRCH')alive=false;}
  if(alive)throw new Error(`Tester already running (PID ${existing.pid}). Concurrent checks would share legacy ports.`);
  await unlink(lockPath);lock=await open(lockPath,'wx');
}
await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
const runId=new Date().toISOString().replace(/[:.]/g,'-');
const directory=resolve(values.output||join(testerRoot,runId));
const outputRelative=relative(root,directory);if(outputRelative.startsWith('..')||isAbsolute(outputRelative)){await lock.close();await unlink(lockPath);throw new Error('Output must stay inside the workspace');}
try {
  if(await readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;}).then(entries=>entries.length))throw new Error('Output directory must be empty; previous reports are preserved');
  await mkdir(directory,{recursive:true});
} catch(error) {await lock.close();await unlink(lockPath);throw error;}
let interrupted=false,activeChild;
const stop=()=>{interrupted=true;killOwnedProcess(activeChild);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
const commit=spawnSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8',windowsHide:true}).stdout?.trim()||'unknown';
const replay=['node scripts/test-app.mjs',`--platform=${values.platform}`,`--mode=${values.mode}`,`--seed=${values.seed}`,`--steps=${values.steps}`,`--repeat=${values.repeat}`,`--artifacts=${values.artifacts}`,`--native-android=${values['native-android']}`,`--trace=${values.trace}`,values.only?`--only=${values.only}`:'',values['android-serial']?`--android-serial=${values['android-serial']}`:'',values['fail-fast']?'--fail-fast':''].filter(Boolean).join(' ');
const report={startedAt:new Date().toISOString(),options,commit,environment:{node:process.version,platform:platform(),arch:arch(),cpus:cpus().length},status:'RUNNING',results:[],replay,diagnostics:DIAGNOSTIC_SCRIPTS};
for(let iteration=1;iteration<=values.repeat;iteration++)for(const check of selected)report.results.push({...check,iteration,status:'PENDING'});
const exists=async filename=>{try{await access(filename);return true;}catch{return false;}};
try{
  report.fingerprint=await sourceFingerprint(root);
  const inventory=await featureInventory(root);await writeFile(join(directory,'inventory.json'),JSON.stringify(inventory,null,2));
  await writeReports(directory,report);console.log(`REPORT ${directory}\n${selected.length} checks × ${values.repeat}; seed ${values.seed}`);
  for(let index=0;index<report.results.length;index++){
    const check=report.results[index],caseDirectory=join(directory,`${check.id}${check.iteration>1?`-${check.iteration}`:''}`);
    if(interrupted||(values['fail-fast']&&report.results.some(result=>['FAIL','TIMEOUT'].includes(result.status)))){check.status='SKIP';check.reason=interrupted?'Run interrupted':'Stopped after a failed check';continue;}
    if(check.systems&&!check.systems.includes(process.platform)){check.status='SKIP';check.reason=`Native harness supports ${check.systems.join(',')}; current OS ${process.platform}`;continue;}
    if(check.artifact&&!(await exists(check.artifact))){check.status='SKIP';check.reason=`Artifact does not exist: ${check.artifact}`;continue;}
    try{for(const port of check.ports)await availablePort(port);}catch(error){check.status='FAIL';check.error=`Test port occupied: ${error.message}. Existing processes were preserved.`;continue;}
    check.status='RUNNING';await writeReports(directory,report);console.log(`START ${check.id} (${index+1}/${report.results.length})`);
    const started=Date.now();
    const instrument=check.executable===process.execPath&&(check.ports.length||check.id==='cross-platform-journey')&&check.id!=='pagination-performance';
    const execution={...check,timeout:check.id==='cross-platform-journey'?check.timeout+Math.max(0,values.steps-6)*profilesCount(values.platform,values.mode)*5000:check.timeout,args:instrument?['--import',pathToFileURL(join(root,'scripts/qa/observe-playwright.mjs')).href,...check.args]:check.args};
    const result=await runCheck(execution,{root,directory:caseDirectory,onChild:child=>activeChild=child,env:{NOCTURNE_QA_DIR:caseDirectory,NOCTURNE_QA_SUITE:check.id,NOCTURNE_QA_PLATFORM:values.platform,NOCTURNE_QA_MODE:values.mode,NOCTURNE_QA_SEED:String(values.seed),NOCTURNE_QA_STEPS:String(values.steps),NOCTURNE_QA_TRACE:values.trace, ...(values['android-serial']?{NOCTURNE_ANDROID_SERIAL:values['android-serial']}:{})}});
    Object.assign(check,result);if(interrupted)check.status='CANCELLED';
    if(check.id==='native-android'&&await exists(join(caseDirectory,'results.json'))){const native=JSON.parse(await readFile(join(caseDirectory,'results.json'),'utf8'));if(native.status==='SKIP'){check.status='SKIP';check.reason=native.reason;}}
    const archived=await archiveEvidence(qaRoot,caseDirectory,started);
    const scenarioFile=check.ownScenarioReport?join(caseDirectory,check.ownScenarioReport):check.scenarioReport?join(caseDirectory,'artifacts',check.scenarioReport):null;
    if(scenarioFile&&await exists(scenarioFile)){
      const data=JSON.parse(await readFile(scenarioFile,'utf8')),scenarios=Array.isArray(data)?data:data.results;
      if(Array.isArray(scenarios))check.scenarios=scenarios.filter(item=>typeof item.passed==='boolean'||['PASS','FAIL','SKIP'].includes(item.status)).map(item=>({name:item.name||item.kind||item.profile,status:item.status||(item.passed?'PASS':'FAIL'),error:item.error,durationMs:item.durationMs}));
      if(check.scenarios?.some(item=>item.status==='FAIL')){check.status='FAIL';check.error=check.scenarios.filter(item=>item.status==='FAIL').map(item=>`${item.name}: ${item.error||'Failed assertion'}`).join('\n');}
    }
    if(values.trace==='failures'&&check.status==='PASS')for(const filename of await filesUnder(caseDirectory))if(filename.endsWith('-trace.zip'))await unlink(filename);
    check.evidence=[...new Set([...archived,...await filesUnder(caseDirectory)])].filter(filename=>filename!==check.logPath);
    console.log(`${check.status} ${check.id} (${Math.round(check.durationMs/1000)}s)`);if(!['PASS','SKIP'].includes(check.status))console.error(check.error||check.tail.slice(-3500));
    await writeReports(directory,report);
  }
  const after=await sourceFingerprint(root);report.results.push({id:'source-integrity',areas:['source'],status:after===report.fingerprint?'PASS':'FAIL',error:after===report.fingerprint?undefined:'Application or test sources changed during this run. Results belong to the starting fingerprint.'});
  report.features=await featureObservation(directory,inventory);await writeFile(join(directory,'features.json'),JSON.stringify(report.features,null,2));
  report.finishedAt=new Date().toISOString();report.status=reportStatus(report.results,{requireNative:values['native-android']==='required',requireArtifacts:values.artifacts==='required'});
  await writeReports(directory,report);await writeFile(join(testerRoot,'latest.json'),JSON.stringify({directory,status:report.status,finishedAt:report.finishedAt},null,2));
  console.log(`${report.status}: ${JSON.stringify(report.counts)}\nHTML ${join(directory,'index.html')}\nJSON ${join(directory,'results.json')}`);
  process.exitCode=interrupted?130:report.status==='FAIL'?1:report.status==='INCOMPLETE'?2:0;
}catch(error){
  killOwnedProcess(activeChild);
  for(const result of report.results)if(['PENDING','RUNNING'].includes(result.status)){result.status='SKIP';result.reason='Tester failed before this check completed';}
  report.results.push({id:'tester-execution',areas:['source'],status:'FAIL',error:error.stack||String(error)});
  report.finishedAt=new Date().toISOString();report.status='FAIL';
  await writeReports(directory,report);
  await writeFile(join(testerRoot,'latest.json'),JSON.stringify({directory,status:report.status,finishedAt:report.finishedAt},null,2));
  console.error(`FAIL tester-execution: ${error.stack}\nREPORT ${join(directory,'index.html')}`);
  process.exitCode=interrupted?130:1;
}finally{killOwnedProcess(activeChild);await lock.close();await unlink(lockPath);}

function profilesCount(target, mode) {
  return mode==='smoke'?(target==='all'?2:1):target==='all'?6:target==='android'?4:2;
}
