import { chromium, _electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { chooseDefaultInterfaceLanguage } from './first-run-language.mjs';

const directory = process.env.NOCTURNE_QA_DIR;
let contextNumber = 0;
const cleanUrl = url => { try { const parsed=new URL(url);return `${parsed.origin}${parsed.pathname}`; } catch { return String(url).slice(0,200); } };

async function observeContext(context) {
  if (!directory || context.__nocturneQaObserved) return context;
  context.__nocturneQaObserved = true;
  const id = `context-${String(++contextNumber).padStart(3,'0')}`;
  await mkdir(directory, {recursive:true});
  const stream=createWriteStream(join(directory,`${id}.ndjson`));
  let eventCount=0, closed=false;
  const features={actions:new Set(),settings:new Set(),commands:new Set(),methods:new Set()}, pages=[];
  const log = event => {
    if (closed || ++eventCount > 100_000) return;
    if (event.action) features.actions.add(event.action);
    if (event.setting) features.settings.add(event.setting);
    if (event.command) features.commands.add(event.command);
    if (event.method) features.methods.add(event.method);
    stream.write(`${JSON.stringify({at:new Date().toISOString(),...event})}\n`);
  };
  await context.exposeBinding('__nocturneQaEvent', (_, event)=>log(event));
  const install = () => {
    if(window.__nocturneQaLoggerInstalled)return;
    window.__nocturneQaLoggerInstalled=true;
    const record=event=>{window.__nocturneQaEvent?.(event).catch(()=>{});};
    for(const type of ['click','input','change','keydown','pointerdown','pointerup','pointercancel','focusin'])document.addEventListener(type,event=>{
      const target=event.target.closest?.('[data-action],[data-setting],[data-setting-option],[data-setting-input],[data-command],[data-selection-handle],[contenteditable="true"],input,textarea,button');
      if(!target)return;
      const sensitive=target.type==='password'||/key|password|token/i.test(target.dataset.setting||target.name||target.id||'');
      record({type,tag:target.tagName.toLowerCase(),action:target.dataset.action,setting:target.dataset.setting||target.dataset.settingOption||target.dataset.settingInput,command:target.dataset.command,inputType:target.type||event.inputType,handle:target.dataset.selectionHandle,pointerType:event.pointerType,x:event.clientX,y:event.clientY,key:type==='keydown'?(sensitive?'redacted':event.key.length===1?'character':event.key):undefined,length:type==='input'&&!sensitive?(target.value??target.textContent)?.length:undefined});
    },true);
    window.addEventListener('resize',()=>record({type:'viewport',width:innerWidth,height:innerHeight,visualHeight:visualViewport?.height}));
    document.addEventListener('visibilitychange',()=>record({type:'visibility',state:document.visibilityState}));
    const methods=['runAction','handleMobileAction','runEditorCommand','setCurrentBlockType','setMobileEditorSelection','clearMobileEditorSelection','createDoc','selectDoc','openDocForm','confirmDeleteDoc','duplicateDoc','openFolderForm','saveLore','openLoreForm','openSettingsTab','updateSettingFromControl','updateSettingFromCustomOption','saveActiveDoc','flushOpenDocuments','setReviewMode','openBookExport','buildNocturneDump','importProjectDump','exportDocById','openReviewNavigator','setSessionPassword','migrateEncryption','switchMobileTab','openMobilePanel','closeTopMobileOverlay'];
    const installMethods=()=>{
      const app=window.nocturneApp;if(!app)return false;
      for(const method of methods){const original=app[method];if(typeof original!=='function'||original.__qaObserved)continue;
        const wrapper=function(...args){record({type:'method',method,action:method==='runAction'||method==='handleMobileAction'?args[0]:undefined,command:method==='runEditorCommand'?args[0]:undefined,setting:method==='updateSettingFromControl'?args[0]?.dataset?.setting:undefined});return original.apply(this,args);};wrapper.__qaObserved=true;app[method]=wrapper;}
      return true;
    };
    if(!installMethods()){const timer=setInterval(()=>{if(installMethods())clearInterval(timer);},50);}
  };
  await context.addInitScript(install);
  const observePage = page => {
    if(pages.includes(page))return;pages.push(page);
    if (process.env.NOCTURNE_QA_SUITE !== 'interface-language-ui') {
      let preparing;
      const prepare = () => preparing ||= chooseDefaultInterfaceLanguage(page).finally(() => { preparing = null; });
      const prepareLoaded = () => prepare().catch(error => { if (!page.isClosed()) log({ type: 'fixture-error', message: error.message }); });
      page.on('domcontentloaded', prepareLoaded);
      const navigate = page.goto.bind(page);
      page.goto = async (...args) => {
        const response = await navigate(...args);
        if (await page.locator('#app').count()) await prepare();
        return response;
      };
      if (page.url() !== 'about:blank') prepareLoaded();
    }
    page.on('pageerror',error=>log({type:'pageerror',message:error.message,stack:error.stack}));
    page.on('console',message=>log({type:'console',level:message.type(),message:message.text().slice(0,6000),location:{...message.location(),url:cleanUrl(message.location().url)}}));
    page.on('requestfailed',request=>log({type:'requestfailed',method:request.method(),url:cleanUrl(request.url()),error:request.failure()?.errorText}));
    page.on('response',response=>log({type:'response',status:response.status(),url:cleanUrl(response.url())}));
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())log({type:'navigation',url:cleanUrl(frame.url())});});
    page.evaluate(install).catch(()=>{});
  };
  context.on('page',observePage);context.pages().forEach(observePage);
  const tracing=process.env.NOCTURNE_QA_TRACE!=='off';
  if(tracing)await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  let finalizing;
  context.__nocturneQaFinalize=()=>finalizing ||= (async()=>{
    for(let i=0;i<pages.length;i++)if(!pages[i].isClosed())await pages[i].screenshot({path:join(directory,`${id}-page-${i+1}.png`),animations:'disabled',caret:'hide',timeout:5000}).catch(()=>{});
    if(tracing)await context.tracing.stop({path:join(directory,`${id}-trace.zip`)}).catch(error=>log({type:'trace-error',message:error.message}));
    await writeFile(join(directory,`${id}-features.json`),JSON.stringify(Object.fromEntries(Object.entries(features).map(([key,values])=>[key,[...values].sort()])),null,2));
    closed=true;
    await new Promise(resolve=>stream.end(resolve));
  })();
  const close=context.close.bind(context);
  context.close=async(...args)=>{await context.__nocturneQaFinalize();return close(...args);};
  return context;
}

if(directory){
  const launch=chromium.launch.bind(chromium);
  chromium.launch=async(...args)=>{
    if (process.env.NOCTURNE_QA_BROWSER_CHANNEL && !args[0]?.executablePath && !args[0]?.channel) args[0] = { ...args[0], channel: process.env.NOCTURNE_QA_BROWSER_CHANNEL };
    const browser=await launch(...args),newContext=browser.newContext.bind(browser);
    browser.newContext=async(...options)=>observeContext(await newContext(...options));
    const close=browser.close.bind(browser);browser.close=async(...options)=>{await Promise.allSettled(browser.contexts().map(context=>context.__nocturneQaFinalize?.()));return close(...options);};
    return browser;
  };
  const launchElectron=_electron.launch.bind(_electron);
  _electron.launch=async(...args)=>{
    const app=await launchElectron(...args),context=app.context();await observeContext(context);
    const close=app.close.bind(app);app.close=async()=>{await context.__nocturneQaFinalize();return close();};
    return app;
  };
}
