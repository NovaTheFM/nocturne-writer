import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filesUnder } from './runner.mjs';

export async function featureInventory(root) {
  const actions=new Map(),settings=new Map(),commands=new Map(),methods=new Map();
  const filenames=(await filesUnder(join(root,'src'))).filter(filename=>filename.endsWith('.js')&&!filename.includes(`${join('src','vendor')}`));
  for(const filename of filenames){
    const lines=(await readFile(filename,'utf8')).split('\n');
    for(let index=0;index<lines.length;index++){
      const source={file:filename.slice(root.length+1).replaceAll('\\','/'),line:index+1};
      for(const [attribute,map]of [['action',actions],['setting',settings],['command',commands]])for(const match of lines[index].matchAll(new RegExp(`data-${attribute}=["']([a-zA-Z][a-zA-Z0-9-]*)["']`,'g'))){if(!map.has(match[1]))map.set(match[1],source);}
      for(const match of lines[index].matchAll(/action === ['"]([a-z][a-z0-9-]*)['"]/g))if(!actions.has(match[1]))actions.set(match[1],source);
      for(const match of lines[index].matchAll(/\b(?:toggle|select|range|input)\(['"]([a-zA-Z][\w]*)['"]/g))if(!settings.has(match[1]))settings.set(match[1],source);
      const method=lines[index].match(/^  (?:async )?([a-zA-Z][\w]*)\([^)]*\) \{$/);if(method&&!methods.has(method[1]))methods.set(method[1],source);
    }
  }
  return Object.fromEntries(Object.entries({actions,settings,commands,methods}).map(([kind,map])=>[kind,[...map].map(([name,source])=>({name,...source})).sort((a,b)=>a.name.localeCompare(b.name))]));
}

export async function featureObservation(directory, inventory) {
  const observed={actions:new Set(),settings:new Set(),commands:new Set(),methods:new Set()};
  for(const filename of await filesUnder(directory))if(/context-\d+-features\.json$/.test(filename)){
    const data=JSON.parse(await readFile(filename,'utf8'));
    for(const kind of Object.keys(observed))for(const name of data[kind]||[])observed[kind].add(name);
  }
  return Object.fromEntries(Object.keys(observed).map(kind=>[kind,inventory[kind].map(feature=>({...feature,observed:observed[kind].has(feature.name)}))]));
}
