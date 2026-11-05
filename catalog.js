'use strict';
// A fixed, offline collection; parents select at most 12 sounds for play.
window.TinyLibrary = (() => {
  const palette=['#e1e9c9','#edd9ca','#f1e5b8','#cbdde4','#e2d6e8','#d6e5dc'];
  const definitions=[
    ['puppy','Puppy','🐶','Animals',3],['kitty','Kitty','🐱','Animals',4],['duck','Duck','🦆','Animals',4],['car','Car','🚗','Things',3],
    ['cow','Cow','🐮','Animals',2],['horse','Horse','🐴','Animals',2],['sheep','Sheep','🐑','Animals',2],['pig','Pig','🐷','Animals',2],['rooster','Rooster','🐓','Animals',2],
    ['elephant','Elephant','🐘','Animals',2],['frog','Frog','🐸','Animals',2],['owl','Owl','🦉','Animals',2],['monkey','Monkey','🐒','Animals',3],['bee','Bee','🐝','Animals',2],['bird','Bird','🐦','Animals',2],
    ['bell','Bell','🔔','Things',2],['train','Train','🚂','Things',2],['racecar','Race car','🏎️','Things',2],['drum','Drum','🥁','Music',2],['guitar','Guitar','🎸','Music',2],['piano','Piano','🎹','Music',2],
    ['rain','Rain','🌧️','Nature',2],['water','Water','💧','Nature',2],['thunder','Thunder','⛈️','Nature',2],['applause','Applause','👏','Things',2]
  ].map(([key,name,emoji,category,version],index)=>Object.freeze({key,name,emoji,category,version,color:palette[index%palette.length],id:`b7b00000-0000-4000-8000-${index.toString(16).padStart(12,'0')}`}));
  const byKey=new Map(definitions.map(item=>[item.key,item]));
  const byEmoji=new Map(definitions.map(item=>[item.emoji,item.key]));
  const audioCache=new Map();
  function audio(key){
    if(!byKey.has(key)||!DEMO_SOUNDS[key])throw new Error('This library recording is unavailable. Reopen the app online to update it.');
    if(!audioCache.has(key))audioCache.set(key,new Blob([Uint8Array.from(atob(DEMO_SOUNDS[key]),c=>c.charCodeAt(0))],{type:'audio/mpeg'}));
    return audioCache.get(key);
  }
  function create(key,active=false){
    const d=byKey.get(key);if(!d)throw new Error('Unknown library sound.');
    return {id:d.id,name:d.name,emoji:d.emoji,color:d.color,photo:null,audio:audio(key),demo:true,demoKey:key,demoVersion:d.version,kind:'library',catalogKey:key,active};
  }
  const isLibrary=item=>item.kind==='library'&&byKey.has(item.catalogKey);
  function counts(items){return{total:items.length,active:items.filter(item=>item.active!==false).length,custom:items.filter(item=>!isLibrary(item)).length,library:items.filter(isLibrary).length};}
  function assertLimits(items){
    const c=counts(items);
    if(c.total>50||c.library>25||c.custom>25||c.active>12)throw new Error('Keep up to 12 on play, 25 library sounds, and 25 custom sounds.');
  }
  function normalize(items){
    const seen=new Set(),result=[];
    for(const old of items){
      const key=old.catalogKey||old.demoKey||byEmoji.get(old.emoji),d=byKey.get(key);
      const library=d&&old.kind!=='custom'&&old.demo&&!old.photo&&old.name===d.name&&old.emoji===d.emoji&&!seen.has(key);
      let next;
      if(library){
        seen.add(key);next={...old,kind:'library',catalogKey:key,active:old.active!==false,photo:null,demoKey:key,demoVersion:d.version,audio:old.demoVersion===d.version&&old.audio instanceof Blob?old.audio:audio(key)};
      }else next={...old,kind:'custom',catalogKey:null,active:old.active!==false,demo:false};
      result.push(Object.keys(next).every(field=>next[field]===old[field])?old:next);
    }
    for(const d of definitions)if(!seen.has(d.key)){
      const item=create(d.key,false);if(result.some(old=>old.id===item.id))item.id=crypto.randomUUID();result.push(item);
    }
    assertLimits(result);return result;
  }
  function starter(){return definitions.map((item,index)=>create(item.key,index<4));}
  function isStarter(items){
    if(items.length!==25||items.some(item=>!isLibrary(item)))return false;
    const active=items.filter(item=>item.active!==false);
    return active.length===4&&active.every((item,index)=>item.catalogKey===definitions[index].key&&item.name===definitions[index].name);
  }
  return Object.freeze({definitions,byKey,audio,create,isLibrary,counts,assertLimits,normalize,starter,isStarter});
})();
