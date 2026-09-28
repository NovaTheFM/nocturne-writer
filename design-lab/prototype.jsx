import React, {useEffect, useMemo, useState} from "react";
import {createRoot} from "react-dom/client";
import {ThemeProvider, createTheme} from "@mui/material/styles";
import {Button, Checkbox, CssBaseline, Dialog, IconButton, MenuItem, Select, Slider, Snackbar, Switch, TextField, Tooltip} from "@mui/material";
import {AnimatePresence, motion, useReducedMotion} from "motion/react";

const NAV = [
  {id:"overview", label:"Обзор", icon:"home", group:"Пространство"},
  {id:"write", label:"Писать", icon:"pen", group:"Пространство"},
  {id:"manuscript", label:"Главы", icon:"file", group:"Пространство", badge:"12"},
  {id:"library", label:"Библиотека", icon:"books", group:"Пространство"},
  {id:"world", label:"Мир истории", icon:"globe", group:"Работа с текстом"},
  {id:"review", label:"Редактура", icon:"review", group:"Работа с текстом", badge:"3"},
  {id:"assistant", label:"Ассистент", icon:"spark", group:"Работа с текстом"},
  {id:"insights", label:"Ритм письма", icon:"chart", group:"Инструменты"},
  {id:"export", label:"Экспорт", icon:"export", group:"Инструменты"},
  {id:"sync", label:"Связь", icon:"sync", group:"Инструменты"},
  {id:"data", label:"Данные", icon:"shield", group:"Инструменты"},
  {id:"settings", label:"Настройки", icon:"settings", group:"Инструменты"},
];

const PATHS = {
  home:<><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-7h6v7"/></>,
  pen:<><path d="m3 21 4.6-1 12-12a2.1 2.1 0 0 0-3-3l-12 12z"/><path d="m14.5 7.5 3 3"/><path d="M3 21h18"/></>,
  file:<><path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M8 12h9M8 16h7"/></>,
  books:<><path d="M3 4h5v17H3zM9 3h5v18H9zM16 5l4-1 2 16-4 1z"/><path d="M3 8h5M9 8h5M17 10l4-1"/></>,
  globe:<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></>,
  review:<><path d="M4 4h16v12H8l-4 4z"/><path d="m8 10 2.5 2.5L16 7"/></>,
  spark:<><path d="m12 2 2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></>,
  chart:<><path d="M3 21h18M5 17l4-5 4 3 6-8"/><circle cx="19" cy="7" r="2"/></>,
  export:<><path d="M4 14v6h16v-6M12 3v13M7 11l5 5 5-5"/></>,
  sync:<><path d="M20 7a8 8 0 0 0-14-2L4 7M4 17a8 8 0 0 0 14 2l2-2"/><path d="M4 3v4h4M20 21v-4h-4"/></>,
  shield:<><path d="M12 2 4 5v7c0 5 3 8 8 10 5-2 8-5 8-10V5z"/><path d="m9 12 2 2 4-4"/></>,
  settings:<><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></>,
  search:<><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
  chevron:<><path d="m9 6 6 6-6 6"/></>,
  down:<><path d="m6 9 6 6 6-6"/></>,
  plus:<><path d="M12 4v16M4 12h16"/></>,
  arrow:<><path d="M4 12h16m-6-6 6 6-6 6"/></>,
  target:<><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
  more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  bold:<><path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z"/></>,
  italic:<><path d="M11 4h8M5 20h8M15 4 9 20"/></>,
  align:<><path d="M4 5h16M4 10h11M4 15h16M4 20h11"/></>,
  link:<><path d="M10 14a5 5 0 0 0 7.5 0l2-2a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7.5 0l-2 2a5 5 0 0 0 7 7l1-1"/></>,
  phone:<><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></>,
  desktop:<><rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8M12 18v4"/></>,
  close:<><path d="M5 5 19 19M19 5 5 19"/></>,
  moon:<><path d="M20 15A8 8 0 0 1 9 4 8.5 8.5 0 1 0 20 15z"/></>,
  info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  wand:<><path d="m4 20 13-13 3 3L7 23zM17 3v2M21 5l-2 2M7 3v2M3 7h2"/></>,
  trash:<><path d="M4 6h16M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
  menu:<><path d="M4 6h16M4 12h16M4 18h16"/></>,
  sun:<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></>,
};
function Icon({name, className="", size=18}){return <svg className={"icon "+className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{PATHS[name]||PATHS.spark}</svg>}

const muiTheme=createTheme({
  palette:{mode:"dark",primary:{main:"#d8ae78",contrastText:"#211a13"},secondary:{main:"#a6c4b7"},background:{default:"#0c0e12",paper:"#1a1e22"},text:{primary:"#f0eee9",secondary:"#a2aab0"}},
  typography:{fontFamily:"Manrope, Arial, sans-serif",button:{textTransform:"none",fontSize:11,fontWeight:800,letterSpacing:".01em"}},
  shape:{borderRadius:10},
  components:{
    MuiButton:{defaultProps:{disableElevation:true},styleOverrides:{root:{minHeight:37,borderRadius:9,padding:"8px 14px"},containedPrimary:{background:"#d8ae78",color:"#241b13","&:hover":{background:"#e5bd8a"}}}},
    MuiTextField:{defaultProps:{size:"small",variant:"outlined"},styleOverrides:{root:{"& .MuiOutlinedInput-root":{background:"#20262a",fontSize:12},"& .MuiInputLabel-root":{fontSize:12}}}},
    MuiSelect:{styleOverrides:{select:{fontSize:11}}},
    MuiCheckbox:{defaultProps:{size:"small"},styleOverrides:{root:{color:"#97846c"}}},
    MuiSwitch:{defaultProps:{size:"small"}},
  }
});
const easing=[.22,1,.36,1];
const chapters=[
  {number:"00",name:"Пролог. Последнее письмо",words:"842 слова",status:"Черновик"},
  {number:"01",name:"Глава 1. Тихий город",words:"2 410 слов",status:"Готово"},
  {number:"02",name:"Глава 2. Дом у воды",words:"1 728 слов",status:"В работе"},
  {number:"03",name:"Глава 3. Порог",words:"1 105 слов",status:"Черновик"},
  {number:"04",name:"Глава 4. Тень на стекле",words:"2 076 слов",status:"Готово"},
];
const worldTabs=["Персонажи","Локации","Хронология","Заметки"];
const settingsTabs=["Общие","Редактор","Словарь","Редактура","Фокус","AI","Данные","Экспорт"];
const formatLabels=["PDF","DOCX","NOCTURNEDUMP"];

function DemoButton({children,onClick,icon,variant="outlined",sx={}}){return <Button className="spring-button" variant={variant} size="small" startIcon={icon?<Icon name={icon} size={15}/>:undefined} sx={sx} onClick={onClick}>{children}</Button>}
function PlainButton({children,onClick,icon}){return <button className="outline-button spring-button" type="button" onClick={onClick}>{icon&&<Icon name={icon}/>} {children}</button>}
function IconAction({name,label,onClick}){return <Tooltip title={label}><IconButton aria-label={label} className="mui-icon-button spring-button" onClick={onClick}><Icon name={name}/></IconButton></Tooltip>}
function PageHeading({kicker,title,subtitle,actions}){return <header className="page-heading"><div><span className="eyebrow">{kicker}</span><h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}</div>{actions&&<div className="heading-actions">{actions}</div>}</header>}
function SectionTitle({title,action,onClick}){return <div className="section-title"><h2>{title}</h2>{action&&<button type="button" onClick={onClick}>{action} →</button>}</div>}
function ShellCard({children,className=""}){return <div className={"surface "+className}>{children}</div>}
function Tabs({items,selected,onChange,label}){return <div className="tab-strip" role="tablist" aria-label={label}>{items.map(item=><button key={item} type="button" role="tab" aria-selected={selected===item} className={"tab-button "+(selected===item?"active":"")} onClick={()=>onChange(item)}>{item}</button>)}</div>}

function Overview({go,notify}){
  return <>
    <PageHeading kicker="Понедельник · 28 сентября" title="Добрый вечер, автор." subtitle="Ваше пространство для историй. Всё важное — перед глазами." actions={<PlainButton icon="search" onClick={()=>notify("Откройте поиск сочетанием Ctrl + K")}>Найти в проекте</PlainButton>}/>
    <section className="hero"><div className="hero-content"><span className="eyebrow">Продолжить историю</span><h1>Там, где история <em>дышит.</em></h1><p>«Дом у воды» ждёт следующей сцены. Последняя правка была сегодня в 18:42 — осталось поймать мысль.</p><DemoButton variant="contained" icon="pen" onClick={()=>go("write")}>Вернуться к главе</DemoButton></div><div className="hero-note">«Всякая история начинается с тишины.»<span>Из заметок автора</span></div></section>
    <div className="metric-row"><ShellCard className="metric"><span className="mini-label">В рукописи</span><strong>48 620</strong><small>слов в 12 главах</small></ShellCard><ShellCard className="metric"><span className="mini-label">Сегодня написано</span><strong>1 240</strong><small className="positive">↗ 62% дневной цели</small></ShellCard><ShellCard className="metric"><span className="mini-label">Серия письма</span><strong>7 дней</strong><small>лучший результат за месяц</small></ShellCard><ShellCard className="metric"><span className="mini-label">Мир истории</span><strong>23</strong><small>персонажа, места и события</small></ShellCard></div>
    <div className="overview-lower"><div><SectionTitle title="Недавно в работе" action="Все главы" onClick={()=>go("manuscript")}/><ShellCard className="section-panel">{chapters.slice(1,5).map(ch=><button key={ch.number} type="button" className="chapter-row" style={{width:"100%",background:"none",borderTop:0,borderLeft:0,borderRight:0,color:"inherit",textAlign:"left"}} onClick={()=>go("write")}><span className="chapter-index">{ch.number}</span><span className="chapter-info"><strong>{ch.name}</strong><small>{ch.words} · {ch.status}</small></span><Icon name="arrow" className="row-arrow"/></button>)}</ShellCard></div><div><SectionTitle title="Тихий прогресс" action="Статистика" onClick={()=>go("insights")}/><ShellCard className="section-panel"><span className="eyebrow" style={{marginBottom:7}}>Слова за неделю</span><div className="chart-area"><svg viewBox="0 0 350 160" preserveAspectRatio="none" aria-label="График написанных слов за неделю"><defs><linearGradient id="overview-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#b7ae8a" stopOpacity=".3"/><stop offset="1" stopColor="#b7ae8a" stopOpacity="0"/></linearGradient></defs><path d="M0 142 C35 128 48 105 70 116 S112 138 137 88 S180 117 212 72 S264 102 286 42 S326 71 350 19 V160 H0Z" fill="url(#overview-fill)"/><path d="M0 142 C35 128 48 105 70 116 S112 138 137 88 S180 117 212 72 S264 102 286 42 S326 71 350 19" fill="none" stroke="#cbb187" strokeWidth="2.5"/></svg></div><div className="chart-axis"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div><div className="chart-note"><span>Лучший день <b>воскресенье</b></span><span>+18%</span></div></ShellCard></div></div>
  </>;
}

function Write({go,selectedChapter,setSelectedChapter,focus,setFocus,notify}){
  const selected=chapters.find(ch=>ch.number===selectedChapter)||chapters[2];
  return <>
    <PageHeading kicker="Рукопись / Глава 02" title={selected.name.replace(/^Глава \d\. /,"")} subtitle="Черновик · последние изменения сегодня в 18:42" actions={<><PlainButton icon="review" onClick={()=>go("review")}>Редактура</PlainButton><DemoButton icon="target" onClick={()=>setFocus(!focus)}>{focus?"Выйти из фокуса":"Режим фокуса"}</DemoButton></>}/>
    <div className="write-layout">
      <nav className="surface chapter-rail" aria-label="Главы рукописи"><div className="rail-title">Рукопись · Том I</div>{chapters.map(ch=><button type="button" key={ch.number} className={"rail-item "+(selectedChapter===ch.number?"active":"")} onClick={()=>setSelectedChapter(ch.number)}><Icon name="file"/><span>{ch.name}<small>{ch.words}</small></span></button>)}</nav>
      <div className="editor-wrap"><div className="editor-toolbar"><span className="toolbar-title">Основной текст</span><IconAction name="bold" label="Жирный — демонстрация" onClick={()=>notify("Панель форматирования — визуальный макет")}/><IconAction name="italic" label="Курсив — демонстрация" onClick={()=>notify("Панель форматирования — визуальный макет")}/><span className="toolbar-divider"/><IconAction name="align" label="Выравнивание — демонстрация" onClick={()=>notify("Панель форматирования — визуальный макет")}/><IconAction name="link" label="Ссылка — демонстрация" onClick={()=>notify("Панель форматирования — визуальный макет")}/><span className="toolbar-divider"/><IconAction name="search" label="Поиск" onClick={()=>notify("Нажмите Ctrl + K для поиска по макету")}/><IconAction name="more" label="Другие инструменты" onClick={()=>notify("Это демонстрация панели инструментов")}/></div><article className="paper" aria-label="Макет страницы рукописи"><div className="paper-kicker">Глава II · Дом у воды</div><h2>Дом у воды</h2><div className="chapter-lede">Некоторые места ждут нас дольше, чем люди.</div><p>Она вернулась к реке на рассвете. В окнах старого дома ещё горел свет, и это было единственным знаком, что письмо дошло.</p><p>Над водой медленно поднимался туман. За дверью кто-то тихо играл на пианино — несколько неуверенных нот, будто вспоминал мелодию вместе с ней.</p><p>Здесь всё осталось прежним: скрип половиц, запах сырого дерева, золотая полоса солнца на лестнице. Только сама она теперь знала, зачем приехала.</p><div className="scene-break">✦ ✦ ✦</div><p>На столе лежал ключ. Рядом — записка, написанная знакомым почерком: «Открой верхний ящик. И, пожалуйста, не бойся того, что найдёшь».</p><div className="paper-footer"><span>НОКТЮРН · РУКОПИСЬ</span><span>— 24 —</span></div></article></div>
      <aside className="surface write-aside"><span className="aside-label">Текущая сцена</span><h3>Возвращение</h3><p>Она впервые за много лет входит в дом у реки.</p><div className="aside-divider"/><span className="aside-label">Ритм главы</span><div className="aside-stat"><span>Слов</span><b>1 728</b></div><div className="aside-stat"><span>Время чтения</span><b>≈ 8 мин</b></div><div className="aside-stat"><span>Статус</span><b>В работе</b></div><div className="aside-divider"/><span className="aside-label">Связи с миром</span><div className="tag-list"><span className="mini-tag">Мира</span><span className="mini-tag">Дом у реки</span><span className="mini-tag">Письмо</span></div><div className="aside-divider"/><span className="aside-label">Заметка к сцене</span><div className="note-preview">«Пианино должно прозвучать до того, как читатель увидит ключ.»</div></aside>
    </div>
  </>;
}

function Manuscript({go,notify}){
  const [tab,setTab]=useState("Рукопись");
  const visible=tab==="Рукопись"?chapters:tab==="Черновики"?chapters.filter(ch=>ch.status==="Черновик"):[{number:"×",name:"Старая версия сцены у вокзала",words:"690 слов",status:"Удалено недавно"}];
  return <><PageHeading kicker="Проект / Рукопись" title="Главы" subtitle="Главы, черновики и удалённые наброски — в одном спокойном пространстве." actions={<DemoButton variant="contained" icon="plus" onClick={()=>notify("Создание главы в этом макете не сохраняется")}>Новая глава</DemoButton>}/><Tabs label="Папки рукописи" items={["Рукопись","Черновики","Корзина"]} selected={tab} onChange={setTab}/><div className="section-title"><h2>{tab==="Рукопись"?"Том I · Начало":tab}</h2><small>{tab==="Рукопись"?"12 глав · 48 620 слов":visible.length+" записи"}</small></div><AnimatePresence mode="wait"><motion.div key={tab} className="manuscript-list" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} transition={{duration:.23,ease:easing}}>{visible.map(ch=><button key={ch.number} className="manuscript-item" onClick={()=>tab==="Корзина"?notify("Восстановление показано только визуально"):go("write")}><span className="manuscript-num">{ch.number}</span><span className="manuscript-main"><strong>{ch.name}</strong><small>{ch.status} · отредактировано недавно</small></span><span className="manuscript-meta">{ch.words}</span><Icon name="chevron"/></button>)}</motion.div></AnimatePresence></>;
}
function Library({go,notify}){
  const books=[{title:"Дом у воды",caption:"Текущий роман · 48 620 слов",style:""},{title:"Город без имён",caption:"Черновик · 12 340 слов",style:"alt"},{title:"На краю света",caption:"Заметки к истории",style:"warm"}];
  return <><PageHeading kicker="Ваши истории" title="Библиотека" subtitle="Место, где каждая новая история получает своё начало." actions={<DemoButton variant="contained" icon="plus" onClick={()=>notify("Новый проект — только визуальная демонстрация")}>Новый проект</DemoButton>}/><div className="library-grid">{books.map((book,i)=><div key={book.title} className="book-card" role="button" tabIndex={0} onClick={()=>i===0?go("overview"):notify("Другие проекты в этом макете показательные")} onKeyDown={e=>{if(e.key==="Enter")i===0?go("overview"):notify("Другие проекты в этом макете показательные")}}><div className={"book-cover "+book.style}><small>NOCTURNE · {i===0?"РОМАН":"ПРОЕКТ"}</small><strong>{book.title}</strong><span>Ваша история начинается здесь</span></div><div className="book-details"><strong>{book.title}</strong><small>{book.caption}</small></div></div>)}</div></>;
}

function World({worldTab,setWorldTab,notify}){
  const people=[["Мира Вольская","Главная героиня","Возвращается в родной город после долгого молчания.","c1"],["Даниэль Арден","Второй голос","Хранит больше, чем готов сказать вслух.","c2"],["Лидия Орлова","Свидетель","Помнит прошлое иначе, чем остальные.","c3"]];
  const places=[["Дом у реки","Дом / Берег","В нём всё началось. И, возможно, закончится.","c1"],["Старый вокзал","Город / Переход","Последнее место, где её видели вместе с отцом.","c2"],["Сад фонарей","Город / Ночь","Тихая площадь, в которой прячутся чужие разговоры.","c3"]];
  return <><PageHeading kicker="Проект / Мир истории" title="База знаний" subtitle="Персонажи, места и события всегда под рукой, пока растёт рукопись." actions={<DemoButton variant="contained" icon="plus" onClick={()=>notify("Добавление записи в этом макете не сохраняется")}>Добавить</DemoButton>}/><Tabs label="Разделы базы знаний" items={worldTabs} selected={worldTab} onChange={setWorldTab}/><AnimatePresence mode="wait"><motion.div key={worldTab} initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} transition={{duration:.23,ease:easing}}>
    {(worldTab==="Персонажи"||worldTab==="Локации")&&<div className="card-grid">{(worldTab==="Персонажи"?people:places).map((item,i)=><button key={item[0]} type="button" className="surface entity-card" style={{textAlign:"left",color:"inherit"}} onClick={()=>notify("Карточка «"+item[0]+"» — демонстрационный профиль")}><div className={"entity-art "+(worldTab==="Персонажи"?"character":"location")+" "+item[3]}><span>{String(i+1).padStart(2,"0")}</span></div><div className="entity-body"><small>{item[1]}</small><h3>{item[0]}</h3><p>{item[2]}</p></div></button>)}</div>}
    {worldTab==="Хронология"&&<div className="timeline">{[["Осень, год назад","Последнее письмо","Неожиданная новость возвращает Миру к дому у воды."],["На рассвете","Возвращение","Поезд останавливается на маленьком вокзале."],["Следующий день","Ключ","На столе появляется предмет, который меняет всю историю."],["Позже","Незнакомый голос","Она слышит пианино в пустой комнате."]].map(item=><ShellCard key={item[1]} className="timeline-item"><small>{item[0]}</small><h3>{item[1]}</h3><p>{item[2]}</p></ShellCard>)}</div>}
    {worldTab==="Заметки"&&<div className="note-grid">{[["Тон истории","Меньше объяснений. Дать тишине работать между репликами."],["О Мире","Она не ищет прощения. Она пытается понять, что именно произошло."],["Дом","Старые комнаты хранят звук: шаги, музыку, недосказанность."],["Финал","Вернуть образ воды, но показать его по-другому."]].map((item,i)=><button key={item[0]} className="sticky-note" style={{textAlign:"left",color:"inherit"}} onClick={()=>notify("Заметка «"+item[0]+"» — демонстрационный текст")}><small>Заметка 0{i+1}</small><h3>{item[0]}</h3><p>{item[1]}</p></button>)}</div>}
  </motion.div></AnimatePresence></>;
}

function Assistant({notify}){
  const [prompt,setPrompt]=useState("");
  return <><PageHeading kicker="Инструменты / Помощник" title="Ассистент" subtitle="Творческий собеседник рядом с рукописью. В этом макете ответы показательные." actions={<PlainButton icon="settings" onClick={()=>notify("Настройки моделей доступны в рабочем приложении")}>Модель и контекст</PlainButton>}/><div className="assistant-layout"><ShellCard className="chat-panel"><div className="chat-head"><span className="orb"/><span><strong>Рабочий диалог</strong><small>Контекст: глава 2 · Мира · Дом у реки</small></span><span style={{marginLeft:"auto"}} className="mini-badge">Демо-режим</span></div><div className="chat-body"><div className="chat-message user">Помоги сделать встречу Миры с домом напряжённее, но без прямой угрозы.</div><div className="chat-message assistant">Можно усилить ожидание через знакомые детали, которые слегка изменились: ключ оставлен не на привычном месте, мелодия обрывается на одной и той же ноте, а следы на крыльце ведут только внутрь. Читатель почувствует тревогу раньше героини.</div><div className="chat-prompt-row">{["Идеи для сцены","Проверь диалог","Краткое резюме"].map(text=><button key={text} className="prompt-chip" onClick={()=>setPrompt(text)}>{text}</button>)}</div></div><div className="chat-compose"><input aria-label="Демонстрационный запрос ассистенту" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Спросить о сцене или персонаже…"/><DemoButton variant="contained" icon="arrow" onClick={()=>{notify("В макете AI-запросы не отправляются");setPrompt("")}}>Отправить</DemoButton></div></ShellCard><ShellCard className="inspector-panel"><span className="eyebrow">В контексте</span><h3>Мир за строками</h3><p>Ассистент видит только то, что вы включили в рабочий контекст.</p>{[["file","Глава 2. Дом у воды"],["globe","Мира Вольская"],["globe","Дом у реки"],["clock","Последние заметки"]].map(item=><div key={item[1]} className="context-row"><Icon name={item[0]}/>{item[1]}</div>)}<div className="aside-divider"/><p>Ваши данные остаются в локальном проекте. Этот экран не подключён к API.</p></ShellCard></div></>;
}

function Review({notify}){
  const [mode,setMode]=useState("Предложения");
  return <><PageHeading kicker="Работа с текстом" title="Редактура" subtitle="Правки видны в контексте и никогда не прячут исходную фразу." actions={<DemoButton icon="wand" onClick={()=>notify("Автопроверка в макете не запускается")}>Проверить главу</DemoButton>}/><Tabs label="Режимы редактуры" items={["Предложения","Комментарии","Финализация"]} selected={mode} onChange={setMode}/><div className="review-grid"><ShellCard className="review-sheet"><span className="paper-kicker">Глава II · Редакторский вид</span><h3>Дом у воды</h3><p>Она вернулась к реке на рассвете. В окнах старого дома <span className="mark-deletion">ещё горел свет</span> <span className="mark-addition">теплился одинокий свет</span>, и это было единственным знаком, что письмо дошло.</p><p>Над водой медленно поднимался туман. За дверью кто-то тихо играл на пианино — несколько неуверенных нот, будто вспоминал мелодию вместе с ней.</p><p>Здесь всё осталось прежним. <span className="mark-addition">Кроме паузы перед каждой знакомой мелодией.</span></p></ShellCard><div><ShellCard className="review-comment"><small>Предложение 01 · Стиль</small><h3>Точнее образ</h3><p>«Одинокий свет» поддерживает настроение возвращения и задаёт контраст с пустым домом.</p><div style={{display:"flex",gap:7}}><DemoButton variant="contained" onClick={()=>notify("В макете правки не применяются")}>Принять</DemoButton><DemoButton onClick={()=>notify("В макете правки не применяются")}>Отклонить</DemoButton></div></ShellCard><ShellCard className="review-comment"><small>Комментарий 02 · Ритм</small><h3>Пауза перед встречей</h3><p>Здесь можно удержать героиню на пороге ещё на одну фразу.</p></ShellCard></div></div></>;
}

function Insights({notify}){
  return <><PageHeading kicker="Инструменты / Ритм" title="Ритм письма" subtitle="Спокойная картина прогресса — без давления и лишних цифр." actions={<PlainButton icon="clock" onClick={()=>notify("Выбор периода — визуальная демонстрация")}>Последние 7 дней</PlainButton>}/><div className="metric-row"><ShellCard className="metric"><span className="mini-label">На этой неделе</span><strong>7 820</strong><small>слов написано</small></ShellCard><ShellCard className="metric"><span className="mini-label">Средний ритм</span><strong>1 117</strong><small>слов в день</small></ShellCard><ShellCard className="metric"><span className="mini-label">Самый долгий сеанс</span><strong>92 мин</strong><small>в воскресенье</small></ShellCard><ShellCard className="metric"><span className="mini-label">Серия</span><strong>7 дней</strong><small className="positive">↗ продолжайте в своём темпе</small></ShellCard></div><div className="stats-grid"><ShellCard className="stat-chart"><span className="eyebrow">Поток письма</span><h3>Слова по дням</h3><div className="chart-big"><svg viewBox="0 0 600 194" preserveAspectRatio="none" aria-label="Демонстрационный график слов по дням"><defs><linearGradient id="insight-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#d3b184" stopOpacity=".3"/><stop offset="1" stopColor="#d3b184" stopOpacity="0"/></linearGradient></defs><path d="M0 155 C50 142 70 80 100 112 S158 135 200 90 S250 113 300 67 S360 105 400 87 S470 46 500 55 S560 79 600 21 V194 H0Z" fill="url(#insight-fill)"/><path d="M0 155 C50 142 70 80 100 112 S158 135 200 90 S250 113 300 67 S360 105 400 87 S470 46 500 55 S560 79 600 21" fill="none" stroke="#d3b184" strokeWidth="3"/></svg></div><div className="chart-axis"><span>Понедельник</span><span>Вторник</span><span>Среда</span><span>Четверг</span><span>Пятница</span><span>Суббота</span><span>Воскресенье</span></div></ShellCard><ShellCard className="goal-figure"><span className="eyebrow">Цель дня</span><div className="goal-ring"><strong>68%</strong></div><span>1 240 / 1 800 слов</span><small>Осталось всего несколько абзацев</small></ShellCard></div></>;
}

function ExportPage({format,setFormat,notify}){
  return <><PageHeading kicker="Инструменты / Выпуск книги" title="Экспорт" subtitle="Соберите рукопись для чтения, редактора или личного архива."/><div className="export-layout"><div className="export-preview"><div className="export-book"><small>НОКТЮРН · РУКОПИСЬ</small><h2>Дом<br/>у воды</h2><span>Роман · Черновое издание</span></div></div><ShellCard className="export-options"><span className="eyebrow">Формат документа</span><h3>Как сохранить историю?</h3><div className="format-list">{formatLabels.map(name=><button key={name} type="button" className={"format "+(format===name?"active":"")} aria-pressed={format===name} onClick={()=>setFormat(name)}><strong>{name}</strong><small>{name==="PDF"?"Для чтения и печати":name==="DOCX"?"Для редактора":"Весь проект"}</small></button>)}</div><div className="option-row"><span>Включить титульную страницу</span><Switch defaultChecked inputProps={{"aria-label":"Включить титульную страницу"}}/></div><div className="option-row"><span>Номера страниц</span><Switch defaultChecked inputProps={{"aria-label":"Номера страниц"}}/></div><div className="option-row"><span>Экспортировать заметки к главам</span><Switch inputProps={{"aria-label":"Экспортировать заметки к главам"}}/></div><div style={{marginTop:23}}><DemoButton variant="contained" icon="export" onClick={()=>notify("Экспорт "+format+" в этом макете не выполняется")}>Собрать {format}</DemoButton></div></ShellCard></div></>;
}

function SyncPage({notify}){
  const [connected,setConnected]=useState(false);
  return <><PageHeading kicker="Инструменты / Устройства" title="Связь по Wi-Fi" subtitle="Наглядная схема связи компьютера и телефона; сеть здесь не подключается."/><ShellCard className="sync-hero"><div><span className="eyebrow">Локальная синхронизация</span><h2>История рядом<br/>на каждом устройстве.</h2><p>Компьютер и телефон сверяют главы и записи, когда находятся в одной сети. Демо показывает возможные состояния подключения.</p><DemoButton variant="contained" icon="sync" onClick={()=>setConnected(!connected)}>{connected?"Отключить демо":"Показать подключение"}</DemoButton></div><div className="device-diagram"><div className="device-icon"><Icon name="desktop" size={34}/></div><span className="device-wire" style={{opacity:connected?1:.4}}/><div className="device-icon phone"><Icon name="phone" size={31}/></div></div></ShellCard><div className="sync-lower"><ShellCard className="sync-card"><span className="eyebrow">Состояние</span><h3>{connected?"Устройства на связи":"Ожидание телефона"}</h3><p>{connected?"Показано визуальное состояние синхронизации. Реального обмена данными здесь нет.":"Подключите телефон к той же сети, чтобы сверить рукопись и базу знаний."}</p><span className="mini-badge">{connected?"● Демонстрация соединения":"○ Готово к подключению"}</span></ShellCard><ShellCard className="sync-card"><span className="eyebrow">Как это выглядит</span><h3>Три коротких шага</h3>{["Одна сеть Wi-Fi","Подтверждение на двух устройствах","Сверка изменений"].map((item,i)=><div className="sync-step" key={item}><i>{i+1}</i>{item}</div>)}</ShellCard></div></>;
}

function DataPage({notify}){
  return <><PageHeading kicker="Инструменты / Хранение" title="Данные и копии" subtitle="Контроль над архивами, восстановлением и защищёнными проектами." actions={<DemoButton variant="contained" icon="plus" onClick={()=>notify("Копия в этом макете не создаётся")}>Создать копию</DemoButton>}/><div className="data-grid"><ShellCard className="data-card"><span className="eyebrow">Резервные копии</span><h3>Надёжный след</h3><p>Вернитесь к сохранённому состоянию, когда нужно проверить старую версию сцены или проекта.</p><div className="backup-row"><span>Сегодня · 18:42</span><span>Автоматическая</span></div><div className="backup-row"><span>Вчера · 21:14</span><span>Ручная</span></div><div className="backup-row"><span>24 сентября · 09:18</span><span>Автоматическая</span></div></ShellCard><ShellCard className="data-card"><span className="eyebrow">Защита</span><h3>История остаётся вашей</h3><p>Документы хранятся локально. Защита и экспорт настраиваются отдельно для каждого проекта.</p><div className="option-row"><span>Шифрование проекта</span><span className="mini-badge">Включено</span></div><div className="option-row"><span>Последняя проверка</span><span>Сегодня</span></div><div className="option-row"><span>Удалённые записи</span><button className="outline-button" onClick={()=>notify("Корзина в этом макете пуста")}><Icon name="trash"/> Корзина</button></div></ShellCard></div></>;
}

function SettingsPage({settingTab,setSettingTab,paperCool,setPaperCool,notify}){
  const content={
    "Общие":["Своя атмосфера","Настройте свет, движение и плотность рабочего пространства.",["Тёплая бумага","Цвет листа в редакторе"],["Плавные переходы","Учитывается системное уменьшение движения"],["Плотность интерфейса","Больше воздуха или больше информации"]],
    "Редактор":["Внимание тексту","Письмо должно оставаться главным, а инструменты — рядом.",["Тёплая бумага","Комфортное чтение на длинной дистанции"],["Подсветка активного абзаца","Лёгкий ориентир в рукописи"],["Размер основного текста","Подберите удобную величину"]],
    "Словарь":["Свой язык","Следите за словами, которые важны именно для этой истории.",["Подсказки при письме","Аккуратные пометки в строке"],["Авторские правила","Не исправлять особые имена и термины"],["Чувствительность","Сколько подсказок показывать"]],
    "Редактура":["Правки в контексте","Смотрите предложения рядом с исходным текстом.",["Показывать замечания","Линии и отметки в редакторе"],["Отмечать повторы","Повторяющиеся конструкции"],["Строгость проверки","От мягкой до подробной"]],
    "Фокус":["Ничего лишнего","Оставьте на экране только страницу и мысль.",["Убирать боковые панели","Больше места для рукописи"],["Тихий индикатор прогресса","Без отвлекающих чисел"],["Ширина страницы","Комфортная длина строки"]],
    "AI":["Собеседник для истории","Вы решаете, что попадёт в контекст запроса.",["Добавлять текущую главу","Только при вашем выборе"],["Подключать мир истории","Персонажи и места в контексте"],["Размер контекста","От краткого до подробного"]],
    "Данные":["Ваш архив","Сохраняйте контроль над локальными копиями и восстановлением.",["Автоматические копии","Периодические снимки проекта"],["Защита проекта","Шифрование локальных записей"],["Частота копий","Под ваш ритм работы"]],
    "Экспорт":["Из рукописи — в книгу","Готовьте файл для читателя или редактора.",["Титульная страница","Оформление готового файла"],["Заметки к главам","Включать только при необходимости"],["Поля страницы","Для чтения или печати"]],
  }[settingTab];
  return <><PageHeading kicker="Пространство / Предпочтения" title="Настройки" subtitle="Подстройте рабочее место под собственный ритм."/><div className="settings-layout"><nav className="surface settings-menu" aria-label="Разделы настроек">{settingsTabs.map(tab=><button type="button" key={tab} className={"settings-button "+(settingTab===tab?"active":"")} onClick={()=>setSettingTab(tab)}>{tab}</button>)}</nav><ShellCard className="settings-pane"><AnimatePresence mode="wait"><motion.div key={settingTab} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} transition={{duration:.22,ease:easing}}><span className="eyebrow">Предпочтения · {settingTab}</span><h2>{content[0]}</h2><p>{content[1]}</p>{content.slice(2).map((line,index)=><div key={line[0]} className="setting-line"><span><strong>{line[0]}</strong><small>{line[1]}</small></span>{index===0&&["Общие","Редактор"].includes(settingTab)?<Switch checked={!paperCool} onChange={()=>setPaperCool(!paperCool)} inputProps={{"aria-label":line[0]}}/>:index===2?<div style={{width:120}}><Slider defaultValue={52} size="small" aria-label={line[0]}/></div>:<Switch defaultChecked inputProps={{"aria-label":line[0]}}/>}</div>)}<div className="setting-line"><span><strong>Сохранение</strong><small>В этом макете настройки не записываются</small></span><span className="mini-badge">Демо</span></div><div style={{paddingTop:22,display:"flex",gap:9,flexWrap:"wrap"}}><DemoButton variant="contained" onClick={()=>notify("Настройки в макете не сохраняются")}>Применить</DemoButton><DemoButton onClick={()=>notify("Этот экран — пример будущего визуального стиля")}>Подробнее о макете</DemoButton></div></motion.div></AnimatePresence></ShellCard></div></>;
}

function App(){
  const [route,setRoute]=useState("overview");
  const [worldTab,setWorldTab]=useState("Персонажи");
  const [settingTab,setSettingTab]=useState("Общие");
  const [selectedChapter,setSelectedChapter]=useState("02");
  const [format,setFormat]=useState("PDF");
  const [focus,setFocus]=useState(false);
  const [paperCool,setPaperCool]=useState(false);
  const [projectOpen,setProjectOpen]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const [moreOpen,setMoreOpen]=useState(false);
  const [query,setQuery]=useState("");
  const [toast,setToast]=useState("");
  const reduceMotion=useReducedMotion();
  const routeLabel=NAV.find(item=>item.id===route)?.label||"Обзор";
  const filtered=useMemo(()=>NAV.filter(item=>item.label.toLowerCase().includes(query.toLowerCase())),[query]);
  const notify=message=>setToast(message);
  const go=id=>{setRoute(id);setMoreOpen(false);setSearchOpen(false);if(id!=="write")setFocus(false);document.querySelector(".page-scroller")?.scrollTo({top:0,behavior:"smooth"})};
  useEffect(()=>{
    const onKey=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setSearchOpen(true)}if(e.key==="Escape"){setMoreOpen(false);setSearchOpen(false);setProjectOpen(false)}};
    window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);
  },[]);
  const page={
    overview:<Overview go={go} notify={notify}/>,
    write:<Write go={go} selectedChapter={selectedChapter} setSelectedChapter={setSelectedChapter} focus={focus} setFocus={setFocus} notify={notify}/>,
    manuscript:<Manuscript go={go} notify={notify}/>,
    library:<Library go={go} notify={notify}/>,
    world:<World worldTab={worldTab} setWorldTab={setWorldTab} notify={notify}/>,
    assistant:<Assistant notify={notify}/>,
    review:<Review notify={notify}/>,
    insights:<Insights notify={notify}/>,
    export:<ExportPage format={format} setFormat={setFormat} notify={notify}/>,
    sync:<SyncPage notify={notify}/>,
    data:<DataPage notify={notify}/>,
    settings:<SettingsPage settingTab={settingTab} setSettingTab={setSettingTab} paperCool={paperCool} setPaperCool={setPaperCool} notify={notify}/>,
  }[route];
  return <ThemeProvider theme={muiTheme}><CssBaseline/><div className={"app "+(focus?"focus-mode ":"")+(paperCool?"cool-paper":"")}>
    <aside className="sidebar"><div className="brand"><span className="brand-mark">N</span><span className="brand-word">Nocturne<small>WRITER STUDIO</small></span></div><button className="project-select spring-button" type="button" onClick={()=>setProjectOpen(true)}><span className="project-icon"><Icon name="books"/></span><span><strong>Дом у воды</strong><small>Ваш основной проект</small></span><Icon name="down" size={14}/></button><nav className="nav-scroll" aria-label="Основная навигация">{["Пространство","Работа с текстом","Инструменты"].map(group=><React.Fragment key={group}><div className="nav-group-label">{group}</div>{NAV.filter(item=>item.group===group).map(item=><button className={"nav-item "+(route===item.id?"active":"")} title={item.label} aria-current={route===item.id?"page":undefined} key={item.id} onClick={()=>go(item.id)}><Icon name={item.icon} className="nav-icon"/><span>{item.label}</span>{item.badge&&<span className="nav-end">{item.badge}</span>}</button>)}</React.Fragment>)}</nav><div className="nav-footer"><div className="daily-card"><div className="daily-top"><span>Цель дня</span><strong>1 240 / 2 000</strong></div><div className="daily-track"><i/></div></div></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumbs"><span>NOCTURNE</span><Icon name="chevron" size={12}/><b>{routeLabel}</b></div><div className="top-spacer"/><span className="top-meta">Том I · Дом у воды</span><span className="top-status"><i className="status-dot"/> Демо-макет</span><IconAction name="search" label="Поиск по разделам (Ctrl + K)" onClick={()=>setSearchOpen(true)}/><IconAction name="settings" label="Настройки" onClick={()=>go("settings")}/></header><main className="page-scroller" id="main-content"><AnimatePresence mode="wait" initial={false}><motion.div key={route} className="page-shell" initial={reduceMotion?false:{opacity:0,y:15,filter:"blur(5px)"}} animate={{opacity:1,y:0,filter:"blur(0px)"}} exit={reduceMotion?{opacity:0}:{opacity:0,y:-10,filter:"blur(4px)"}} transition={{duration:reduceMotion?.01:.31,ease:easing}}>{page}</motion.div></AnimatePresence></main></div>
    <nav className="mobile-nav" aria-label="Мобильная навигация">{[...NAV.filter(item=>["overview","write","manuscript","world"].includes(item.id)),{id:"more",label:"Ещё",icon:"menu"}].map(item=><button key={item.id} type="button" aria-current={route===item.id?"page":undefined} className={(route===item.id||item.id==="more"&&moreOpen?"active":"")} onClick={()=>item.id==="more"?setMoreOpen(!moreOpen):go(item.id)}><Icon name={item.icon}/>{item.label}</button>)}</nav>
    <AnimatePresence>{moreOpen&&<motion.div className="mobile-more" initial={{opacity:0,y:26}} animate={{opacity:1,y:0}} exit={{opacity:0,y:26}} transition={{duration:.25,ease:easing}}><span className="eyebrow">Другие разделы</span><div className="mobile-more-grid">{NAV.filter(item=>!["overview","write","manuscript","world"].includes(item.id)).map(item=><button key={item.id} onClick={()=>go(item.id)}><Icon name={item.icon}/>{item.label}</button>)}</div></motion.div>}</AnimatePresence>
    <Dialog open={projectOpen} onClose={()=>setProjectOpen(false)} className="nocturne-dialog" aria-labelledby="project-dialog-title"><div className="dialog-body"><span className="dialog-eyebrow">Текущий проект</span><h2 id="project-dialog-title">Дом у воды</h2><p>Рабочее пространство романа. В макете проект можно посмотреть, но смена не сохраняется.</p><div className="dialog-actions"><DemoButton onClick={()=>setProjectOpen(false)}>Закрыть</DemoButton><DemoButton variant="contained" onClick={()=>{setProjectOpen(false);go("library")}}>Библиотека</DemoButton></div></div></Dialog>
    <Dialog open={searchOpen} onClose={()=>setSearchOpen(false)} className="nocturne-dialog" aria-labelledby="search-dialog-title"><div className="dialog-body"><span className="dialog-eyebrow">Быстрый переход · Ctrl + K</span><h2 id="search-dialog-title">Куда отправимся?</h2><TextField fullWidth autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Найти раздел..." inputProps={{"aria-label":"Найти раздел"}}/><div style={{marginTop:13,maxHeight:260,overflow:"auto"}}>{filtered.map(item=><button key={item.id} className="nav-item" onClick={()=>go(item.id)}><Icon name={item.icon}/><span style={{display:"inline"}}>{item.label}</span></button>)}{!filtered.length&&<div className="empty-note">Разделов не найдено</div>}</div></div></Dialog>
    <Snackbar open={Boolean(toast)} autoHideDuration={3300} onClose={()=>setToast("")} message={toast} anchorOrigin={{vertical:"bottom",horizontal:"center"}}/>
  </div></ThemeProvider>;
}

createRoot(document.getElementById("root")).render(<App/>);
