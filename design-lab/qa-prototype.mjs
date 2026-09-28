import {chromium} from "playwright";
import {mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const out=fileURLToPath(new URL("./.qa/",import.meta.url));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const scenarios=[
  {name:"desktop",viewport:{width:1440,height:900},mobile:false},
  {name:"tablet",viewport:{width:820,height:1180},mobile:false},
  {name:"mobile",viewport:{width:390,height:844},mobile:true},
  {name:"small-mobile",viewport:{width:360,height:780},mobile:true},
];
const ids=["overview","write","manuscript","library","world","review","assistant","insights","export","sync","data","settings"];
const errors=[];
for(const scenario of scenarios){
  const page=await browser.newPage({viewport:scenario.viewport,deviceScaleFactor:1});
  page.on("pageerror",e=>errors.push(scenario.name+": "+e.message));
  page.on("console",e=>{if(e.type()==="error")errors.push(scenario.name+" console: "+e.text())});
  await page.goto("http://localhost:5173/design-lab/nocturne-react-mui.html",{waitUntil:"load"});
  try{await page.locator(".hero").waitFor({timeout:3000})}catch(e){console.log(JSON.stringify({earlyErrors:errors,body:(await page.locator("body").innerText()).slice(0,500)}));throw e}
  for(const id of ids){
    if(id!=="overview"){
      if(scenario.mobile){
        const main=page.locator(".mobile-nav button").filter({hasText:{"write":"Писать","manuscript":"Главы","world":"Мир истории"}[id]||"\uFFFF"});
        if(["write","manuscript","world"].includes(id)) await main.click();
        else {
          await page.locator(".mobile-nav button").last().click();
          await page.locator(".mobile-more button").filter({hasText:({"library":"Библиотека","review":"Редактура","assistant":"Ассистент","insights":"Ритм письма","export":"Экспорт","sync":"Связь","data":"Данные","settings":"Настройки"})[id]}).click();
        }
      } else await page.locator(".sidebar .nav-item").filter({hasText:({"write":"Писать","manuscript":"Главы","library":"Библиотека","world":"Мир истории","review":"Редактура","assistant":"Ассистент","insights":"Ритм письма","export":"Экспорт","sync":"Связь","data":"Данные","settings":"Настройки"})[id]}).click();
      await page.waitForTimeout(470);
    }
    const dimensions=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,scroller:document.querySelector(".page-scroller")?.scrollWidth,client:document.querySelector(".page-scroller")?.clientWidth,heading:document.querySelector(".page-heading h1")?.textContent||""}));
    if(dimensions.document>dimensions.viewport+1||dimensions.scroller>dimensions.client+2){
      const offenders=await page.evaluate(()=>[...document.querySelectorAll("#main-content *")].map(el=>({tag:el.tagName,cls:el.className?.baseVal||el.className||"",right:Math.round(el.getBoundingClientRect().right),left:Math.round(el.getBoundingClientRect().left),scroll:el.scrollWidth,client:el.clientWidth})).filter(el=>el.right>innerWidth+1).slice(0,12));
      errors.push(scenario.name+"/"+id+" overflow "+JSON.stringify({dimensions,offenders}));
    }
    if(["overview","write","world","assistant","export","sync","settings"].includes(id)) await page.screenshot({path:out+"/"+scenario.name+"-"+id+".png",fullPage:false});
  }
  if(scenario.mobile){
    await page.locator(".mobile-nav button").filter({hasText:"Мир истории"}).click();
    await page.waitForTimeout(370);
    await page.getByRole("tab",{name:"Хронология"}).click();
    await page.waitForTimeout(370);
    if(!await page.getByText("Последнее письмо").count())errors.push(scenario.name+" world tab failed");
    await page.locator(".mobile-nav button").last().click();
    if(!await page.locator(".mobile-more").isVisible())errors.push(scenario.name+" more sheet failed");
    await page.locator(".mobile-nav button").last().click();
  } else if(scenario.name==="desktop"){
    await page.getByRole("button",{name:"Редактор",exact:true}).last().click();
    await page.waitForTimeout(280);
    if(!await page.getByRole("heading",{name:"Внимание тексту"}).count())errors.push("settings tab failed");
    await page.locator(".project-select").click();
    if(!await page.getByRole("dialog").isVisible())errors.push("project dialog failed");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    if(!await page.getByRole("dialog").isVisible())errors.push("command search failed");
    await page.getByRole("textbox",{name:"Найти раздел"}).fill("Экспорт");
    await page.getByRole("dialog").getByRole("button",{name:"Экспорт"}).click();
    await page.waitForTimeout(400);
    await page.getByRole("button",{name:"DOCX"}).click();
    if(!await page.getByRole("button",{name:"Собрать DOCX"}).count())errors.push("format selection failed");
    await page.locator(".sidebar .nav-item").filter({hasText:"Связь"}).click();
    await page.waitForTimeout(400);
    await page.getByRole("button",{name:"Показать подключение"}).click();
    if(!await page.getByText("Устройства на связи").count())errors.push("sync demo state failed");
    await page.locator(".sidebar .nav-item").filter({hasText:"Писать"}).click();
    await page.waitForTimeout(400);
    await page.getByRole("button",{name:"Режим фокуса"}).click();
    if(!await page.locator(".app.focus-mode").count())errors.push("focus mode failed");
  }
  await page.close();
}
const offline=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:"reduce"});
offline.on("pageerror",e=>errors.push("offline: "+e.message));
offline.on("request",request=>{if(/^https?:/.test(request.url()))errors.push("offline external request: "+request.url())});
await offline.goto(new URL("nocturne-react-mui.html",import.meta.url).href,{waitUntil:"load"});
await offline.locator(".hero").waitFor({timeout:5000});
const fontReady=await offline.evaluate(async()=>{await document.fonts.ready;return document.fonts.check("16px Manrope")});
if(!fontReady)errors.push("offline embedded fonts failed");
await offline.locator(".sidebar .nav-item").filter({hasText:"Писать"}).click();
await offline.waitForTimeout(100);
if(!await offline.locator(".paper").isVisible())errors.push("offline reduced-motion navigation failed");
await offline.close();
await browser.close();
console.log(JSON.stringify({screenshots:scenarios.length*7,standaloneOffline:true,errors},null,2));
if(errors.length)process.exitCode=1;
