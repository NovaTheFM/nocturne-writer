import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './runner.mjs';

const directory=resolve(process.env.NOCTURNE_QA_DIR||'release/qa/cross-platform-journey');
const platform=process.env.NOCTURNE_QA_PLATFORM||'all',mode=process.env.NOCTURNE_QA_MODE||'full';
const seed=Number(process.env.NOCTURNE_QA_SEED||20261004),steps=Number(process.env.NOCTURNE_QA_STEPS||6);
const port=await availablePort(),url=`http://127.0.0.1:${port}`;
await mkdir(directory,{recursive:true});
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:'ignore',windowsHide:true,detached:process.platform!=='win32'});
const browser=await chromium.launch({headless:true});
const profiles=[
  {id:'desktop-dark',platform:'desktop',width:1440,height:900,theme:'nocturne',motion:'no-preference',sweep:true},
  {id:'desktop-paper',platform:'desktop',width:1280,height:800,theme:'paper',motion:'reduce'},
  {id:'android-compact',platform:'android',width:320,height:740,theme:'nocturne',motion:'reduce'},
  {id:'android-dark',platform:'android',width:390,height:844,theme:'nocturne',motion:'no-preference',sweep:true},
  {id:'android-paper',platform:'android',width:390,height:844,theme:'paper',motion:'reduce'},
  {id:'android-landscape',platform:'android',width:844,height:390,theme:'paper',motion:'reduce'},
].filter(profile=>(platform==='all'||profile.platform===platform)&&(mode==='full'||['desktop-dark','android-dark'].includes(profile.id)));
const results=[];
const segments=new Intl.Segmenter('ru',{granularity:'grapheme'});
const semanticDocument=value=>JSON.parse(JSON.stringify(value,(key,value)=>key==='blockOrder'?undefined:value));
function random(initial){let value=initial>>>0;return()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)/4294967296;};}
async function settled(page){await page.evaluate(async()=>{const animations=document.getAnimations().filter(animation=>animation.playState==='running'&&animation.effect?.getComputedTiming().iterations!==Infinity);await Promise.race([Promise.allSettled(animations.map(animation=>animation.finished)),new Promise(resolve=>setTimeout(resolve,900))]);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});}
async function exerciseSettings(page, actions) {
  const scope=await page.evaluate(()=>window.nocturneApp.isMobileLayout()?'#mobile-panel .mobile-settings-content':'#settings-overlay');
  const keys=await page.locator(scope).evaluate(root=>[...new Set([...root.querySelectorAll('[data-setting], [data-setting-select]')].map(element=>element.dataset.setting||element.dataset.settingSelect))]);
  const deferred=new Set(['e2e','gitVersioning','activeLoreId','aiProvider','aiEndpoint','aiKey','aiModel','smartDictionaryEndpoint','smartDictionaryKey']);
  const dictionaryEnabled=await page.evaluate(()=>window.nocturneApp.state.settings.smartDictionary);
  try { for(const key of keys){
    const before=await page.evaluate(key=>window.nocturneApp.state.settings[key],key);
    if(deferred.has(key)||!['boolean','number','string'].includes(typeof before)){actions.push({kind:'setting-deferred',key,reason:'Special workflow or non-scalar value'});continue;}
    const control=page.locator(`${scope} [data-setting="${key}"]`).first(),select=page.locator(`${scope} [data-setting-select="${key}"]`).first();
    const element=await select.count()?select:control;
    if(await element.evaluate(element=>!!element.closest('.smart-dictionary-subpanel:not(.open)'))){
      await page.locator(`${scope} [data-setting="smartDictionary"]`).click();
      await page.waitForFunction(()=>window.nocturneApp.state.settings.smartDictionary===true);
      await settled(page);
    }
    if(!await element.isVisible()){actions.push({kind:'setting-deferred',key,reason:'Control is hidden in the current mode'});continue;}
    const set=async value=>{
      if(await select.count()){
        await select.locator('.nocturne-select-trigger').click({timeout:10000});
        const option=select.locator(`[data-setting-option][data-value="${String(value).replaceAll('"','\\"')}"]`);await option.click({timeout:10000});
      }else if(typeof before==='boolean'){
        const label=control.locator('xpath=ancestor::label[1]');
        await (await control.getAttribute('type')==='checkbox'&&await label.count()?label:control).click({timeout:10000});
      }
      else if(await control.getAttribute('type')==='range')await control.evaluate((element,value)=>{element.value=String(value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));},value);
      else{await control.fill(String(value));await control.press('Tab');}
    };
    let next;
    if(await select.count()){const values=await select.locator('[data-setting-option]').evaluateAll(elements=>elements.map(element=>element.dataset.value));next=values.find(value=>value!==String(before));if(next===undefined)continue;}
    else if(typeof before==='boolean')next=!before;
    else if(await control.getAttribute('type')==='range'){const range=await control.evaluate(element=>({min:Number(element.min),max:Number(element.max),step:Number(element.step)||1}));next=Number((before<range.max?Math.min(range.max,before+range.step):Math.max(range.min,before-range.step)).toFixed(4));}
    else if(typeof before==='string')next='QA fixture';else continue;
    actions.push({kind:'setting-attempt',key});
    await set(next);
    await page.waitForFunction(({key,before})=>window.nocturneApp.state.settings[key]!==before,{key,before});
    const changed=await page.evaluate(async key=>{const a=window.nocturneApp;await a.persistSettings();return {value:a.state.settings[key],saved:(await a.db.get('settings','app')).value[key]};},key);
    assert.notEqual(changed.value,before,`Setting ${key} changes`);assert.deepEqual(changed.saved,changed.value,`Setting ${key} persists`);
    actions.push({kind:'setting-roundtrip',key});
    await set(before);await page.evaluate(()=>window.nocturneApp.persistSettings());
    assert.deepEqual(await page.evaluate(key=>window.nocturneApp.state.settings[key],key),before,`Setting ${key} restores`);
  }} finally {
    if(await page.evaluate(()=>window.nocturneApp.state.settings.smartDictionary)!==dictionaryEnabled){
      await page.locator(`${scope} [data-setting="smartDictionary"]`).click();
      await page.evaluate(()=>window.nocturneApp.persistSettings());
      assert.equal(await page.evaluate(()=>window.nocturneApp.state.settings.smartDictionary),dictionaryEnabled);
    }
  }
}
async function inspect(page){return page.evaluate(()=>{
  const issues=[],warnings=[];
  if(document.documentElement.scrollWidth>innerWidth+1)issues.push({type:'horizontal-overflow',actual:document.documentElement.scrollWidth,viewport:innerWidth});
  const ids=new Set();for(const element of document.querySelectorAll('[id]')){if(ids.has(element.id))warnings.push({type:'duplicate-id',id:element.id});ids.add(element.id);}
  for(const element of document.querySelectorAll('button,[role="button"],[role="switch"],input:not([type="hidden"]),select,textarea')){
    if(element.disabled||element.closest('[inert],[aria-hidden="true"]')||!element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))continue;
    const rect=element.getBoundingClientRect();if(rect.width<1||rect.height<1)continue;
    const labelRect=[...(element.labels||[])].find(label=>label.contains(element))?.getBoundingClientRect();
    const width=Math.max(rect.width,labelRect?.width||0),height=Math.max(rect.height,labelRect?.height||0);
    const label=element.getAttribute('aria-label')||element.getAttribute('title')||element.textContent?.trim()||element.labels?.[0]?.textContent||element.placeholder;
    if(!label)warnings.push({type:'missing-control-name',tag:element.tagName,action:element.dataset.action,setting:element.dataset.setting});
    if(document.body.classList.contains('mobile-shell-active')&&(width<24||height<24))issues.push({type:'small-touch-target',tag:element.tagName,class:element.className,action:element.dataset.action,setting:element.dataset.setting||element.dataset.settingInput,width,height});
    else if(document.body.classList.contains('mobile-shell-active')&&(width<44||height<44))warnings.push({type:'touch-target-under-44',action:element.dataset.action,setting:element.dataset.setting,width,height});
  }
  return{issues,warnings,viewport:{width:innerWidth,height:innerHeight},settings:window.nocturneApp.getSettingsRegistry().map(({key,tab,type,label})=>({key,tab,type,label}))};
});}
try{
  for(let attempt=0;attempt<100;attempt++){if(server.exitCode!==null)throw new Error('Owned journey server exited');try{if((await fetch(url)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  for(const profile of profiles){
    const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},isMobile:profile.platform==='android',hasTouch:profile.platform==='android',reducedMotion:profile.motion,locale:'ru-RU',userAgent:profile.platform==='android'?'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36':undefined});
    const page=await context.newPage(),errors=[],audits=[],actions=[];
    page.on('pageerror',error=>errors.push(error.message));
    const started=Date.now(),next=random(seed),folder=join(directory,profile.id);await mkdir(folder,{recursive:true});
    const snapshot=async name=>{await settled(page);const audit=await inspect(page);audits.push({name,...audit});await page.screenshot({path:join(folder,`${name}.png`),animations:'disabled',caret:'hide'});assert.deepEqual(audit.issues,[],`${name}: ${JSON.stringify(audit.issues)}`);};
    try{
      await page.goto(url);await page.waitForSelector('.app-shell.ready');
      await page.evaluate(theme=>{const a=window.nocturneApp;a.state.settings.theme=theme;a.applySettings();},profile.theme);
      await snapshot('01-empty');
      await page.locator('.empty-project-create:visible').first().click();
      await page.locator('#form-overlay.active [name="title"]').fill('Тихий город');
      await page.locator('#form-overlay.active [type="submit"]').click();
      await page.waitForFunction(()=>!!window.nocturneApp.nocturneEditor.get('primary'));
      const firstDoc=await page.evaluate(()=>window.nocturneApp.state.activeDocId);
      let expected=await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').getText());
      assert.match(expected,/^Тихий город\s*$/);
      const tokens=['Ночь. ','Элиза вернулась. ','«Где ты?» ','🙂 ','е́ ','Дождь — тишина. '];
      for(let step=0;step<steps;step++){
        await page.locator('.ProseMirror').click();
        await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').commands.focus('end'));
        const previous=expected,remove=expected.length&&next()<0.3;
        if(remove){const last=[...segments.segment(expected)].at(-1);expected=expected.slice(0,last.index);await page.keyboard.press('Backspace');actions.push({step,kind:'backspace',expectedLength:expected.length});}
        else{const text=tokens[Math.floor(next()*tokens.length)];expected+=text;await page.keyboard.insertText(text);actions.push({step,kind:'insert',text});}
        await page.waitForFunction(text=>window.nocturneApp.nocturneEditor.get('primary').getText()===text,expected);
        await page.keyboard.press('Control+z');await page.waitForFunction(text=>window.nocturneApp.nocturneEditor.get('primary').getText()===text,previous);
        await page.keyboard.press('Control+Shift+z');await page.waitForFunction(text=>window.nocturneApp.nocturneEditor.get('primary').getText()===text,expected);
        await page.evaluate(()=>window.nocturneApp.flushOpenDocuments());
        await page.reload();await page.waitForSelector('.app-shell.ready');
        assert.equal(await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').getText()),expected,'Roundtrip text must match the independent model');
      }
      await snapshot('02-writing');
      const manuscript=await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').getJSON());
      const tabs=profile.sweep?['visual','editor','focus','review','dictionary','macros','formatting','ai','data','export','misc']:['visual','editor'];
      for(const tab of tabs){await page.evaluate(tab=>window.nocturneApp.openSettingsTab(tab),tab);await snapshot(`settings-${tab}`);if(profile.sweep)await exerciseSettings(page,actions);assert.deepEqual(await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').getJSON()),manuscript,'Opening settings must preserve the manuscript');}
      await page.evaluate(()=>{const a=window.nocturneApp;if(a.isMobileLayout())a.closeMobileToEditor();else document.querySelector('#settings-overlay').classList.remove('active');});
      await page.evaluate(()=>window.nocturneApp.flushOpenDocuments());
      await context.setOffline(true);
      await page.evaluate(()=>{const a=window.nocturneApp;a.openDocForm(a.defaultFolderId());});
      await page.locator('#form-overlay.active [name="title"]').fill('Офлайн-глава');await page.locator('#form-overlay.active [type="submit"]').click();
      await page.waitForFunction(()=>window.nocturneApp.state.docs.length===2);
      assert.equal(await page.evaluate(async()=> (await window.nocturneApp.db.getAll('docs')).length),2,'Offline IndexedDB write');
      await context.setOffline(false);await page.reload();await page.waitForSelector('.app-shell.ready');
      assert.equal(await page.evaluate(()=>window.nocturneApp.state.docs.length),2);
      assert.deepEqual(semanticDocument(await page.evaluate(id=>window.nocturneApp.state.docs.find(doc=>doc.id===id).pmJson,firstDoc)),semanticDocument(manuscript),'The first manuscript survives the second chapter and reload');
      await snapshot('03-offline-roundtrip');
      assert.deepEqual(errors,[],'No uncaught errors');
      results.push({profile:profile.id,status:'PASS',durationMs:Date.now()-started,actions,audits});
    }catch(error){await page.screenshot({path:join(folder,'failure.png')}).catch(()=>{});results.push({profile:profile.id,status:'FAIL',error:error.stack,errors,actions,audits,durationMs:Date.now()-started});}
    finally{await context.close();await writeFile(join(directory,'results.json'),JSON.stringify({status:results.some(result=>result.status==='FAIL')?'FAIL':'PASS',seed,results},null,2));console.log(`${results.at(-1).status} ${profile.id}${results.at(-1).error?'\n'+results.at(-1).error:''}`);}
  }
}finally{await browser.close();killOwnedProcess(server);}
if(results.some(result=>result.status==='FAIL'))process.exitCode=1;
