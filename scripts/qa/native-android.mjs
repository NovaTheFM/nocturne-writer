import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const directory=resolve(process.env.NOCTURNE_QA_DIR||'release/qa/native-android');
await mkdir(directory,{recursive:true});
let sdk=process.env.ANDROID_SDK_ROOT||process.env.ANDROID_HOME||'';
if(!sdk)try{sdk=(await readFile('android/local.properties','utf8')).match(/^sdk\.dir=(.+)$/m)?.[1]?.trim().replaceAll('\\','/')||'';}catch{}
const adb=process.env.NOCTURNE_ADB||(sdk?join(sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb'):'adb');
const invoke=(args,options={})=>spawnSync(adb,args,{encoding:'utf8',windowsHide:true,timeout:12_000,...options});
const devices=invoke(['devices']);
let report={status:'SKIP',reason:'Нет доступного Android-устройства или adb.'},browser,serial,forward,page,paletteOpened=false;
try{
  if(devices.error)throw Object.assign(new Error(devices.error.message),{skip:true});
  const available=(devices.stdout||'').split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>parts[1]==='device').map(parts=>parts[0]);
  serial=process.env.NOCTURNE_ANDROID_SERIAL||available[0];
  if(!serial||!available.includes(serial))throw Object.assign(new Error('Нет авторизованного online Android-устройства. Подключите тестовый телефон или загрузите эмулятор.'),{skip:true});
  const command=args=>{const result=invoke(['-s',serial,...args]);if(result.error||result.status!==0)throw new Error(result.error?.message||result.stderr||`adb exited ${result.status}`);return(result.stdout||'').trim();};
  const appId='com.bebranova.nocturne';
  if(!command(['shell','pm','path',appId]).startsWith('package:'))throw Object.assign(new Error('APK Nocturne не установлен на выбранном устройстве. Тестер не устанавливает и не очищает пользовательское приложение.'),{skip:true});
  command(['shell','am','start','-n',`${appId}/.MainActivity`]);
  let socket;
  for(let attempt=0;attempt<40;attempt++){
    const pid=command(['shell','pidof',appId]).split(/\s+/)[0];
    const sockets=command(['shell','cat','/proc/net/unix']);
    socket=sockets.match(new RegExp(`@([^\\s]*webview_devtools_remote_${pid}[^\\s]*)`))?.[1];
    if(socket)break;await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!socket)throw Object.assign(new Error('У APK недоступен WebView DevTools. Для проверки нужна debug-сборка; очистка данных не выполнялась.'),{skip:true});
  forward=command(['forward','tcp:0',`localabstract:${socket}`]);
  assert.match(forward,/^\d+$/);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${forward}`);
  page=browser.contexts().flatMap(context=>context.pages()).find(page=>/localhost|nocturne/i.test(page.url()));
  assert.ok(page,'Nocturne WebView page');
  await page.waitForSelector('.app-shell.ready');
  const initial=await page.evaluate(()=>{const a=window.nocturneApp;return{runtime:a.runtime,tab:a.state.mobile.activeTab,panel:a.state.mobile.panel,keyboard:a.state.mobile.keyboardOpen,docs:a.state.docs.length};});
  const busy=await page.evaluate(()=>window.nocturneApp.commandPalette.opened||!!document.querySelector('.overlay.active,.form-overlay.active'));
  if(initial.panel||initial.keyboard||busy)throw Object.assign(new Error('На устройстве открыт рабочий диалог или клавиатура. Закройте его перед нативным прогоном.'),{skip:true});
  assert.equal(initial.runtime.isAndroid,true);assert.equal(initial.runtime.isCapacitor,true);
  const checks=[];
  const geometry=await page.evaluate(()=>({navigation:[...document.querySelectorAll('.mobile-bottom-nav button')].map(button=>({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height})),overflow:document.documentElement.scrollWidth>innerWidth+1,ratio:devicePixelRatio}));
  assert.equal(geometry.navigation.length,5);assert.equal(geometry.overflow,false);assert.ok(geometry.navigation.every(button=>button.width>=44&&button.height>=44));checks.push('real WebView geometry');
  const plugins=await page.evaluate(()=>Object.fromEntries(['App','Filesystem','Share','StatusBar','NocturneLan'].map(name=>[name,window.Capacitor.isPluginAvailable(name)])));
  assert.ok(Object.values(plugins).every(Boolean),JSON.stringify(plugins));checks.push('registered native plugins');
  await page.screenshot({path:join(directory,'native-app.png')});
  await page.locator('.mobile-topbar [data-action="open-command-palette"]').click();
  paletteOpened=true;
  const field=page.locator('[data-command-palette-input]:visible');await field.waitFor();
  const rect=await field.boundingBox();
  command(['shell','input','tap',String(Math.round((rect.x+rect.width/2)*geometry.ratio)),String(Math.round((rect.y+rect.height/2)*geometry.ratio))]);
  await page.waitForFunction(()=>window.nocturneApp.state.mobile.keyboardOpen,null,{timeout:8000});
  command(['shell','input','text','nocturne']);await page.waitForFunction(()=>document.querySelector('[data-command-palette-input]')?.value.includes('nocturne'));checks.push('real Android keyboard and input');
  await page.screenshot({path:join(directory,'native-keyboard.png')});
  command(['shell','input','keyevent','KEYCODE_BACK']);await page.waitForFunction(()=>!window.nocturneApp.state.mobile.keyboardOpen,null,{timeout:8000});
  command(['shell','input','keyevent','KEYCODE_BACK']);await page.waitForFunction(()=>!window.nocturneApp.commandPalette.opened);checks.push('Android Back');
  assert.equal(await page.evaluate(()=>window.nocturneApp.state.docs.length),initial.docs);
  report={status:'PASS',serial,checks,plugins,geometry,limits:['Нативная проверка не изменяет рукопись и не очищает приложение.','Share, системный выбор файлов, физический LAN и разные клавиатуры требуют отдельных сценариев.']};
}catch(error){report={status:error.skip?'SKIP':'FAIL',reason:error.message,error:error.skip?undefined:error.stack,serial};if(!error.skip)process.exitCode=1;}
finally{
  if(paletteOpened&&page&&!page.isClosed()){
    const keyboardOpen=await page.evaluate(()=>window.nocturneApp.state.mobile.keyboardOpen).catch(()=>false);
    if(serial&&keyboardOpen)invoke(['-s',serial,'shell','input','keyevent','KEYCODE_BACK']);
    await page.evaluate(()=>{if(window.nocturneApp.commandPalette.opened)window.nocturneApp.commandPalette.close({restoreFocus:false});}).catch(()=>{});
  }
  await browser?.close().catch(()=>{});
  if(serial&&forward)invoke(['-s',serial,'forward','--remove',`tcp:${forward}`]);
  await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
