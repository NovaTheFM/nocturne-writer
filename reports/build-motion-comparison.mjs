import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argumentsMap = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
const beforeDirectory = resolve(argumentsMap.before);
const afterDirectory = resolve(argumentsMap.after);
const directory = resolve(argumentsMap.output || 'release/visual-comparison-v2');
const ffmpeg = process.env.NOCTURNE_FFMPEG || 'ffmpeg';
async function readEvidence(file) {
  const deadline = Date.now() + 600_000;
  for (;;) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (!argumentsMap.wait || Date.now() > deadline || (error.code !== 'ENOENT' && !(error instanceof SyntaxError))) throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
  }
}
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
await mkdir(join(directory, 'media'), { recursive: true });

const cases = [
  { id: 'dictionary-filter', title: 'Подсветка фильтра словаря', problem: 'При выборе «Мои» исчезающие карточки складывались в одной позиции и давали белую вспышку.', change: 'Координаты сохраняются до изменения списка. Исчезают только карточки в видимой области, каждая на своём месте.', action: '«Все» → «Мои» → «Все».', kind: 'motion' },
  { id: 'dictionary-search', title: 'Перестроение словаря', problem: 'Поиск и очистка строки повторяли белую вспышку из наложенных копий.', change: 'Поиск использует те же сохранённые координаты. Высота списка и его карточки двигаются вместе.', action: 'Поиск «слофо» и очистка строки.', kind: 'motion' },
  { id: 'notes-panel', title: 'Верх панели заметок и задачи', problem: 'Панель начиналась на высоте 64 px при панели инструментов 90 px. В низком окне длинные задачи сжимали заголовок до 33 px.', change: 'Верх привязан к фактической панели инструментов. Заголовок сохраняет высоту, длинное содержимое прокручивается отдельно.', action: 'Открытая панель. Дополнительно: низкое окно с 40 задачами.', kind: 'still' },
  { id: 'formatting-delete', title: 'Удаление правила автозамены', problem: 'Исчезающая копия удалённого переключателя могла пересекаться с соседней строкой при перестроении.', change: 'Строка сначала плавно исчезает, затем соседние строки занимают её место. Копии переключателя нет; состояние оставшегося переключателя сохраняется.', action: 'Удаление включённого правила перед выключенным.', kind: 'motion' },
  { id: 'macro-helper', title: 'Подсказка записи макроса', problem: 'Предыдущая галерея показывала удаление макроса вместо подсказки. При сворачивании подсказка выносилась в отдельную копию.', change: 'Эта запись показывает саму подсказку: раскрытие и сворачивание внутри карточки, вместе с её высотой.', action: '«Записать» → подсказка → остановка записи.', kind: 'motion' },
  { id: 'macro-delete', title: 'Удаление макроса целиком', problem: 'Короткий предыдущий ролик обрывался до завершения удаления и перестроения.', change: 'Обе записи включают подтверждение, исчезновение карточки и завершённое перестроение. Высота списка следует движению карточек.', action: 'Удалить → подтвердить → дождаться перестроения.', kind: 'motion' },
  { id: 'floating-resize', title: 'Карточки всех заметок и размер окна', problem: 'Карточки двигались, а высота окна менялась скачком.', change: 'Сетка меняет высоту в одной FLIP-анимации с карточками; окно плавно уменьшается и центрируется. Заголовок не сжимается.', action: 'Удаление карточки; на телефоне — трёх карточек подряд.', kind: 'motion' },
  { id: 'selection', title: 'Плавное движение выделения', problem: 'Сглаживание отключалось именно при перетаскивании. Граница прыгала сразу к следующей букве.', change: 'Прямоугольник плавно догоняет границу символов во время движения. Выбранные символы меняются сразу, без задержки. На ПК записано настоящее перетаскивание мышью.', action: 'Расширение и обратное уменьшение выделения. Телефон: последовательное изменение границ выделения.', kind: 'motion' },
];
const configurations = [
  { id: 'desktop-dark', title: 'ПК · 1280 × 900', width: 1280, height: 900 },
  { id: 'mobile-dark', title: 'Телефон · 390 × 844', width: 390, height: 844 },
  { id: 'desktop-short', title: 'Низкое окно · 1280 × 600', width: 1280, height: 600 },
  { id: 'desktop-light', title: 'ПК · светлая тема', width: 1280, height: 900 },
  { id: 'mobile-light', title: 'Телефон · светлая тема', width: 390, height: 844 },
];

async function run(args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Media conversion ${code}: ${errors}`)));
  });
}
const manifest = { generatedAt: new Date().toISOString(), beforeDirectory, afterDirectory, playbackFPS: 60, gifFPS: 50, cases: [] };
for (const item of cases) {
  const entry = { ...item, configurations: [] };
  for (const config of configurations) {
    if (item.kind === 'motion' && !['desktop-dark', 'mobile-dark'].includes(config.id)) continue;
    const scene = item.id === 'selection' ? (config.id === 'desktop-dark' ? 'selection-native' : 'selection-drag') : item.id;
    const pair = { ...config };
    for (const [phase, source] of [['before', beforeDirectory], ['after', afterDirectory]]) {
      const name = `${config.id}-${scene}`, prefix = `media/${item.id}-${config.id}-${phase}`;
      if (item.kind === 'still') {
        const target = `${prefix}.png`;
        await copyFile(join(source, `${name}.png`), join(directory, target));
        pair[phase] = { image: target };
      } else {
        const metadata = await readEvidence(join(source, `${name}.json`));
        if (metadata.fps !== 60 || !metadata.video || metadata.distinctFrames < 10) throw new Error(`Invalid motion evidence: ${name}`);
        const video = `${prefix}.webm`, apng = `${prefix}.png`, gif = `${prefix}.gif`, poster = `${prefix}-poster.png`;
        const convert = !argumentsMap.only || argumentsMap.only === item.id;
        const fullVideo = item.id === 'selection' ? `${prefix}-full.webm` : null;
        if (convert && !argumentsMap.reuse && !argumentsMap.htmlOnly) {
          if (fullVideo) {
            await copyFile(join(source, metadata.video), join(directory, fullVideo));
            const crop = config.id === 'desktop-dark' ? 'crop=780:280:420:300' : 'crop=390:350:0:65';
            await run(['-i', join(source, metadata.video), '-vf', crop, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '12', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', join(directory, video)]);
          } else await copyFile(join(source, metadata.video), join(directory, video));
          await run(['-i', join(directory, video), '-frames:v', '1', join(directory, poster)]);
        }
        if (convert && !argumentsMap.htmlOnly) await run(['-i', join(directory, video), '-filter_complex', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-c:v', 'apng', '-pix_fmt', 'pal8', '-plays', '0', '-f', 'apng', join(directory, apng)]);
        if (convert && !argumentsMap.reuse && !argumentsMap.htmlOnly) await run(['-i', join(directory, video), '-filter_complex', 'fps=50,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', join(directory, gif)]);
        pair[phase] = { video, apng, gif, poster, fullVideo, fps: metadata.fps, frames: metadata.frames, seconds: metadata.seconds, distinctFrames: metadata.distinctFrames };
      }
    }
    if (item.kind === 'motion' && pair.before.frames !== pair.after.frames) throw new Error(`Unequal recording length: ${item.id}/${config.id}`);
    entry.configurations.push(pair);
  }
  manifest.cases.push(entry);
  console.log(`Prepared ${item.id}: ${entry.configurations.length} comparisons`);
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const data = JSON.stringify(manifest).replace(/</g, '\u003c');
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nocturne — исправления движения</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101016;color:#ededf3;--border:#35353e;--muted:#aaaab9;--accent:#ae93ff}*{box-sizing:border-box}body{margin:0}button,select,input{font:inherit}button,select{color:inherit;background:#23232e;border:1px solid var(--border);border-radius:10px;padding:10px 14px;min-height:44px;cursor:pointer}button:hover{background:#30303c}button:focus-visible,select:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.4;cursor:default}header{padding:24px 28px;border-bottom:1px solid var(--border)}header h1{font-size:23px;margin:0 0 7px}header p{margin:0;color:var(--muted);line-height:1.5}a{color:#c1adff}main{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:calc(100vh - 120px)}nav{border-right:1px solid var(--border);padding:18px;display:flex;flex-direction:column;gap:6px}nav button{width:100%;text-align:left;border-color:transparent;background:transparent;line-height:1.4}nav button[aria-current=true]{background:#302743;border-color:#65508f}nav small{display:block;color:var(--muted);margin-bottom:8px}.content{padding:22px 26px;min-width:0}h2{font-size:22px;margin:0 0 12px}.copy{display:grid;grid-template-columns:1fr 1fr;gap:20px;line-height:1.6;color:#cfcfd8;margin-bottom:12px}.copy strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.copy p{margin:4px 0 0}.action{margin:0 0 17px;color:var(--muted);font-size:14px}.options,.controls{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:12px 0}.options label{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)}.options select{max-width:100%;font-size:13px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pane{margin:0;min-width:0;background:#09090e;border:1px solid var(--border);border-radius:14px;overflow:hidden}.pane figcaption{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;background:#1b1b24;font-weight:650}.pane figcaption small{font-weight:400;color:var(--muted)}.media{display:flex;align-items:center;justify-content:center;min-height:160px;background:#09090e;position:relative}.media video,.media img{display:block;width:100%;height:auto;max-height:62vh;object-fit:contain;cursor:zoom-in}.pane .links{padding:10px 14px;display:flex;gap:13px;flex-wrap:wrap;font-size:12px;border-top:1px solid #292934}.controls{padding:12px;border:1px solid var(--border);border-radius:12px}.controls input[type=range]{flex:1;min-width:160px;accent-color:var(--accent);cursor:pointer;min-height:44px}.controls output{font-variant-numeric:tabular-nums;min-width:100px;font-size:13px;color:var(--muted)}.footnote{font-size:12px;line-height:1.6;color:var(--muted)}footer{display:flex;justify-content:space-between;gap:12px;padding:16px 0 4px}#position{color:var(--muted);align-self:center}.badge{font-size:12px;display:inline-block;border:1px solid #615080;background:#2c223d;color:#d6c7ff;border-radius:999px;padding:4px 10px;margin-bottom:10px}dialog{width:96vw;max-width:none;background:#111119;border:1px solid #555268;border-radius:14px;padding:16px;color:inherit}dialog::backdrop{background:#000c}.zoom-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.zoom-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.zoom-pair video,.zoom-pair img{width:100%;max-height:80vh;object-fit:contain}.zoom-pair p{margin:0 0 8px;font-weight:650}[hidden]{display:none!important}@media(max-width:1000px){main{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid var(--border);flex-direction:row;overflow:auto;padding:10px}nav button{min-width:185px;width:auto;font-size:13px}nav small{display:none}.content{padding:18px}.media video,.media img{max-height:56vh}}@media(max-width:600px){header{padding:18px}header h1{font-size:20px}.content{padding:14px}.copy{grid-template-columns:1fr;gap:10px}.pair{gap:7px}.pane figcaption{font-size:13px;padding:9px}.pane figcaption small{display:none}.pane .links{padding:9px;gap:8px;font-size:11px}.options{align-items:stretch}.options label{flex-direction:column;align-items:flex-start}.controls{gap:6px}.controls button{padding:9px}.controls input[type=range]{flex-basis:100%;order:2}h2{font-size:20px}.zoom-pair{grid-template-columns:1fr}footer{position:sticky;bottom:0;background:#101016;border-top:1px solid var(--border);padding-bottom:10px}}
.options label{min-width:0;max-width:100%}.options select{min-width:0;width:100%}@media(max-width:600px){footer button{flex:1;min-width:0}#position{flex-shrink:0;font-size:12px;white-space:nowrap}}</style></head><body>
<header><h1>Nocturne — исправленное движение</h1><p>8 исправлений · слева предыдущий результат, справа исправленный · записи и APNG в 60 FPS.</p></header>
<main><nav aria-label="Исправления"><small>Выберите исправление</small>${cases.map((item, index) => `<button data-case="${index}">${index + 1}. ${escape(item.title)}</button>`).join('')}</nav><section class="content">
<span class="badge" id="badge">60 FPS</span><h2 id="title" aria-live="polite"></h2><div class="copy"><div><strong>Причина</strong><p id="problem"></p></div><div><strong>Исправление</strong><p id="change"></p></div></div><p class="action" id="action"></p>
<div class="options"><label>Экран<select id="configuration"></select></label><label id="mode-label">Просмотр<select id="mode"><option value="video">Запись · 60 FPS · управление кадрами</option><option value="apng">Анимированное изображение APNG · 60 FPS</option></select></label><label id="speed-label">Скорость<select id="speed"><option value="1">1×</option><option value="0.5">0,5×</option><option value="0.25">0,25×</option></select></label><button id="zoom">Увеличить пару</button></div>
<div class="pair"><figure class="pane"><figcaption>До<small>Предыдущая правка</small></figcaption><div class="media" id="before"></div><div class="links" id="before-links"></div></figure><figure class="pane"><figcaption>После<small>Исправлено</small></figcaption><div class="media" id="after"></div><div class="links" id="after-links"></div></figure></div>
<div class="controls" id="controls"><button id="play">Пауза</button><button id="replay">Повтор</button><button id="back-frame" aria-label="Предыдущий кадр">−1 кадр</button><button id="next-frame" aria-label="Следующий кадр">+1 кадр</button><input id="timeline" type="range" min="0" max="149" value="0" step="1" aria-label="Кадр записи"><output id="frame">0 / 149</output></div>
<p class="footnote" id="timing">Источник: браузер рисует кадр каждые 16,667 мс. Это запись реальных состояний интерфейса, без размножения кадров из старого ролика. При паузе можно переходить по одному кадру. APNG сохраняет 60 FPS; GIF в ссылках — дополнительный экспорт 50 FPS, явно обозначенный отдельно.</p>
<p class="footnote">Проверены светлая и тёмная темы, телефон и низкое окно. Сценарии телефона выполнялись в браузере с сенсорным viewport; физическое Android-устройство в этом прогоне не проверялось. Старое сравнение: <a href="../visual-comparison/previous-index.html">предыдущая галерея</a>.</p>
<footer><button id="previous">← Предыдущее</button><span id="position"></span><button id="next">Следующее исправление →</button></footer>
</section></main><dialog id="zoom-dialog"><div class="zoom-head"><strong id="zoom-title"></strong><button id="close-zoom">Закрыть</button></div><div class="zoom-pair" id="zoom-content"></div></dialog>
<script id="comparison-data" type="application/json">${data}</script><script>
const data=JSON.parse(document.getElementById('comparison-data').textContent),$=id=>document.getElementById(id);
let current=0,configIndex=0,videos=[],playing=false,raf=0,generation=0,seeking=false;
const item=()=>data.cases[current],pair=()=>item().configurations[configIndex];
function pause(){playing=false;videos.forEach(video=>video.pause());$('play').textContent='Воспроизвести';cancelAnimationFrame(raf)}
async function play(){if(!videos.length)return;playing=true;videos.forEach(video=>video.playbackRate=Number($('speed').value));try{await Promise.all(videos.map(video=>video.play()));$('play').textContent='Пауза';tick()}catch{pause()}}
function tick(){cancelAnimationFrame(raf);if(!playing||!videos[0])return;const a=videos[0],b=videos[1],max=pair().before.frames-1;if(a.ended||a.currentTime>=pair().before.seconds-.012){pause();setFrame(max);return}if(!seeking){const drift=a.currentTime-b.currentTime,rate=Number($('speed').value);if(Math.abs(drift)>.1)b.currentTime=a.currentTime;else b.playbackRate=rate*(Math.abs(drift)>1/60?(drift>0?1.025:.975):1)}const frame=Math.min(max,Math.floor(a.currentTime*60));$('timeline').value=frame;$('frame').textContent=frame+' / '+max;raf=requestAnimationFrame(tick)}
async function setFrame(frame){pause();seeking=true;const selected=Math.max(0,Math.min(pair().before.frames-1,Number(frame)));await Promise.all(videos.map(video=>new Promise(resolve=>{const done=()=>{video.removeEventListener('seeked',done);resolve()};video.addEventListener('seeked',done,{once:true});video.currentTime=(selected+.35)/60;setTimeout(done,1200)})));seeking=false;$('timeline').value=selected;$('frame').textContent=selected+' / '+(pair().before.frames-1)}
function addLink(parent,path,label){const a=document.createElement('a');a.href=path;a.textContent=label;a.download=path.split('/').pop();parent.append(a)}
function renderMedia(){pause();generation++;const own=generation;videos=[];const selected=pair(),isMotion=item().kind==='motion',mode=$('mode').value;$('controls').hidden=!isMotion||mode!=='video';$('mode-label').hidden=!isMotion;$('speed-label').hidden=!isMotion||mode!=='video';$('badge').textContent=isMotion?'60 FPS · '+selected.before.frames+' кадров':'Статичный вид';for(const phase of ['before','after']){const asset=selected[phase],host=$(phase),links=$(phase+'-links');host.replaceChildren();links.replaceChildren();if(isMotion&&mode==='video'){const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';video.poster=asset.poster;video.src=asset.video;video.setAttribute('aria-label',(phase==='before'?'До: ':'После: ')+item().title);host.append(video);videos.push(video);addLink(links,asset.video,'WebM · 60 FPS');addLink(links,asset.apng,'APNG · 60 FPS');addLink(links,asset.gif,'GIF · 50 FPS')}else{const image=document.createElement('img');image.src=isMotion?asset.apng:asset.image;image.alt=(phase==='before'?'До: ':'После: ')+item().title;host.append(image);addLink(links,image.src,isMotion?'APNG · 60 FPS':'PNG');if(isMotion)addLink(links,asset.gif,'GIF · 50 FPS')}}if(isMotion){$('timeline').max=selected.before.frames-1;$('timeline').value=0;$('frame').textContent='0 / '+(selected.before.frames-1);if(mode==='video')Promise.all(videos.map(video=>video.readyState>=1?Promise.resolve():new Promise(resolve=>video.addEventListener('loadedmetadata',resolve,{once:true})))).then(()=>{if(generation===own)play()})}}
function render(){const entry=item();$('title').textContent=entry.title;$('problem').textContent=entry.problem;$('change').textContent=entry.change;$('action').textContent=entry.action;$('configuration').replaceChildren(...entry.configurations.map((config,index)=>{const option=document.createElement('option');option.value=index;option.textContent=config.title;return option}));$('configuration').value=configIndex;$('position').textContent=(current+1)+' / '+data.cases.length;$('previous').disabled=current===0;$('next').disabled=current===data.cases.length-1;document.querySelectorAll('[data-case]').forEach(button=>button.setAttribute('aria-current',Number(button.dataset.case)===current));renderMedia();location.hash='fix-'+entry.id}
function choose(index){const previousId=pair()?.id;current=Math.max(0,Math.min(data.cases.length-1,index));configIndex=Math.max(0,item().configurations.findIndex(config=>config.id===previousId));render()}
document.querySelectorAll('[data-case]').forEach(button=>button.onclick=()=>choose(Number(button.dataset.case)));$('previous').onclick=()=>choose(current-1);$('next').onclick=()=>choose(current+1);$('configuration').onchange=()=>{configIndex=Number($('configuration').value);renderMedia()};$('mode').onchange=renderMedia;$('speed').onchange=()=>videos.forEach(video=>video.playbackRate=Number($('speed').value));$('play').onclick=()=>playing?pause():play();$('replay').onclick=async()=>{await setFrame(0);play()};$('timeline').oninput=()=>setFrame($('timeline').value);$('back-frame').onclick=()=>setFrame(Number($('timeline').value)-1);$('next-frame').onclick=()=>setFrame(Number($('timeline').value)+1);
function openZoom(){pause();const content=$('zoom-content');content.replaceChildren();$('zoom-title').textContent=item().title;for(const phase of ['before','after']){const asset=pair()[phase],section=document.createElement('div'),label=document.createElement('p');label.textContent=phase==='before'?'До':'После';section.append(label);if(item().kind==='motion'&&$('mode').value==='video'){const video=document.createElement('video');video.src=asset.video;video.controls=true;video.muted=true;video.playsInline=true;video.currentTime=Number($('timeline').value)/60;section.append(video)}else{const image=document.createElement('img');image.src=item().kind==='motion'?asset.apng:asset.image;image.alt=label.textContent;section.append(image)}content.append(section)}$('zoom-dialog').showModal()}
$('zoom').onclick=openZoom;$('before').onclick=openZoom;$('after').onclick=openZoom;$('close-zoom').onclick=()=>$('zoom-dialog').close();$('zoom-dialog').addEventListener('close',()=>{$('zoom-content').querySelectorAll('video').forEach(video=>video.pause());$('zoom-content').replaceChildren()});document.addEventListener('keydown',event=>{if(event.target.matches('input,select')||$('zoom-dialog').open)return;if(event.key==='ArrowRight'){event.preventDefault();choose(current+1)}if(event.key==='ArrowLeft'){event.preventDefault();choose(current-1)}if(event.key===' '&&videos.length){event.preventDefault();playing?pause():play()}});const requested=data.cases.findIndex(entry=>'#fix-'+entry.id===location.hash);if(requested>=0)current=requested;render();
</script></body></html>`;
await writeFile(join(directory, 'index.html'), html);
const files = await readdir(join(directory, 'media'));
const bytes = (await Promise.all(files.map(file => stat(join(directory, 'media', file))))).reduce((sum, info) => sum + info.size, 0);
console.log(JSON.stringify({ index: join(directory, 'index.html'), cases: cases.length, files: files.length, mediaBytes: bytes }));
