'use strict';
const $ = (selector) => document.querySelector(selector);
const COLORS = ['#e1e9c9', '#edd9ca', '#f1e5b8', '#cbdde4', '#e2d6e8', '#d6e5dc'];
// Keep the play surface small; the parent collection holds 25 defaults + 25 custom sounds.
const MAX_BUTTONS = 12, MAX_CUSTOM = 25;
const DB_NAME = 'tiny-sounds';
let db, boardRevision = 0, board = [], urls = [], initialized = false, storageOK = false;
let audioContext, output, currentSource, playSequence = 0;
let syncMeta = {owner:null,remoteRevision:0,dirty:false};
const buffers = new Map();
let flashTimer, noticeTimer, editorSession = 0, draft = null, photoURL = null;
let recorder = null, stream = null, recordTimer, recordStarted = 0, recordingPending = false, photoPending = false;
let saving = false, busyBoard = false, deleteId = null;

function notify(message) {
  $('#notice').textContent = message; $('#notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('#notice').hidden = true, 5500);
}
function editorError(message = '') {
  $('#editor-error').textContent = message; $('#editor-error').hidden = !message;
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Tiny Sounds tabs and try again.'));
    request.onsuccess = () => {
      const result = request.result;
      result.onversionchange = () => { result.close(); storageOK = false; notify('Storage changed in another tab. Reopen the app.'); };
      resolve(result);
    };
  });
}
function readBoard() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readonly');
    const store = tx.objectStore('state');
    const request = store.get('board'), revision = store.get('revision'), meta = store.get('sync-meta');
    tx.oncomplete = () => { boardRevision = revision.result || 0; syncMeta=meta.result || syncMeta; resolve(request.result); };
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
function writeBoard(next, options={}) {
  TinyLibrary.assertLimits(next);
  const expected=options.expectedRevision ?? boardRevision;
  return new Promise((resolve,reject)=>{
    if(!db||!storageOK)return reject(new Error('Device storage is unavailable. Enable site storage, then reopen the app.'));
    const tx=db.transaction('state','readwrite'),store=tx.objectStore('state');
    let conflict=false,nextMeta;
    const meta=store.get('sync-meta'),revision=store.get('revision');
    revision.onsuccess=()=>{
      if((revision.result||0)!==expected){conflict=true;tx.abort();return;}
      const latest=meta.result || syncMeta;
      nextMeta=options.meta || (options.system?latest:{...latest,dirty:true});
      store.put(next,'board');store.put(expected+1,'revision');store.put(nextMeta,'sync-meta');
      if(options.backup)store.put(options.backup,'board-backup');
    };
    tx.oncomplete=()=>{boardRevision=expected+1;syncMeta=nextMeta;resolve();if(!options.system&&!options.meta)setTimeout(()=>window.TinySoundsSync?.localChanged(),0);};
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(conflict?Object.assign(new Error('Another window saved changes. Reopen this app before editing again so those changes are preserved.'),{code:'LOCAL_CHANGED'}):tx.error);
  });
}
function storedValue(key, value) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('state',value===undefined?'readonly':'readwrite'),store=tx.objectStore('state');
    const req=value===undefined?store.get(key):store.put(value,key);
    tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
const syncAdapter = {
  snapshot:()=>({items:board,revision:boardRevision,meta:{...syncMeta}}),
  busy:()=>saving||busyBoard||$('#editor').open||$('#delete-dialog').open||$('#swap-dialog').open,
  backup:items=>storedValue('board-backup',items),
  hasBackup:async()=>Boolean(await storedValue('board-backup')),
  async replace(items,meta,expected,backup){
    if(this.busy())throw Object.assign(new Error('Finish editing before downloading account changes.'),{code:'LOCAL_BUSY'});
    await writeBoard(items,{meta,expectedRevision:expected,backup});
    board=items;buffers.clear();stopSound();render();Promise.allSettled(board.filter(item=>item.active!==false).map(decodeSound));
  },
  async checkCurrent(expected){
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('state','readonly'),store=tx.objectStore('state');
      const revision=store.get('revision'),meta=store.get('sync-meta');
      tx.oncomplete=()=>{
        if((revision.result||0)!==boardRevision)return reject(Object.assign(new Error('Another window changed this board. Reopen this window before syncing again.'),{code:'LOCAL_STALE'}));
        if(expected!==undefined && expected!==(revision.result||0))return reject(Object.assign(new Error('Newer edits are waiting to sync.'),{code:'LOCAL_CHANGED'}));
        syncMeta=meta.result || syncMeta;resolve();
      };
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  },
  async markUploaded(uploadedRevision,owner,remoteRevision){
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('state','readwrite'),store=tx.objectStore('state');let next,stale;
      const revision=store.get('revision');
      revision.onsuccess=()=>{
        stale=(revision.result||0)!==boardRevision;
        next={owner,remoteRevision,dirty:(revision.result||0)!==uploadedRevision};
        store.put(next,'sync-meta');
      };
      tx.oncomplete=()=>{if(stale)reject(Object.assign(new Error('Another window changed this board. Reopen this window before syncing again.'),{code:'LOCAL_STALE'}));else{syncMeta=next;resolve();}};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  },
  async restore(){
    if(this.busy())throw new Error('Finish editing before restoring a previous board.');
    const backup=await storedValue('board-backup');if(!backup)return;const previous=TinyLibrary.normalize(backup);
    await writeBoard(previous,{backup:board});board=previous;buffers.clear();stopSound();render();Promise.allSettled(board.filter(item=>item.active!==false).map(decodeSound));
  }
};
function storageMessage(error) {
  return error?.name === 'QuotaExceededError' ? 'This device is out of storage. Free some space and try again. Your saved board is unchanged.' : (error?.message || 'Could not save. Your saved board is unchanged. Please try again.');
}

const DEMO_KEYS = Object.fromEntries(TinyLibrary.definitions.map(item=>[item.emoji,item.key]));
const DEMO_VERSIONS = Object.fromEntries(TinyLibrary.definitions.map(item=>[item.key,item.version]));
const demoAudio=key=>TinyLibrary.audio(key);
const defaultBoard=()=>TinyLibrary.starter();
const upgradeDemoSounds=items=>TinyLibrary.normalize(items);
function audioEngine() {
  if (audioContext) return audioContext;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('Audio playback is not supported in this browser.');
  audioContext = new Audio();
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -18; compressor.knee.value = 18; compressor.ratio.value = 12;
  compressor.attack.value = .003; compressor.release.value = .18;
  const cap = audioContext.createWaveShaper();
  const curve = new Float32Array(4096);
  for (let i=0;i<curve.length;i++) curve[i] = .48*Math.tanh(2*(i*2/(curve.length-1)-1));
  cap.curve = curve;
  output = audioContext.createGain(); output.gain.value = .65;
  output.connect(compressor); compressor.connect(cap); cap.connect(audioContext.destination);
  return audioContext;
}
async function decodeSound(item) {
  if (buffers.has(item.id)) return buffers.get(item.id);
  const buffer = await audioEngine().decodeAudioData(await item.audio.arrayBuffer());
  // Attenuate loud recordings, never amplify quiet ones.
  let peak = 0;
  for (let c=0;c<buffer.numberOfChannels;c++) {
    const channel = buffer.getChannelData(c);
    for (let i=0;i<channel.length;i++) peak=Math.max(peak,Math.abs(channel[i]));
  }
  if (peak>.7) for (let c=0;c<buffer.numberOfChannels;c++) {
    const channel=buffer.getChannelData(c); for (let i=0;i<channel.length;i++) channel[i]*=.7/peak;
  }
  buffers.set(item.id,buffer); return buffer;
}
function stopSound() {
  playSequence++;
  if (currentSource) { try { currentSource.stop(); } catch {} currentSource.disconnect(); currentSource=null; }
}
async function playSound(item) {
  try {
    const keep=new Set(board.filter(item=>item.active!==false).map(item=>item.id));keep.add(item.id);keep.add('preview');
    for(const id of buffers.keys())if(!keep.has(id))buffers.delete(id);
    const context=audioEngine();
    // Resume inside the user gesture, before any decoding awaits.
    const resume=context.resume(); stopSound(); const sequence=playSequence;
    const buffer=await decodeSound(item); await resume;
    if (sequence!==playSequence || document.hidden) return;
    const source=context.createBufferSource(); source.buffer=buffer; source.connect(output);
    currentSource=source;
    source.onended=()=>{source.disconnect();if(currentSource===source)currentSource=null;};
    source.start();
  } catch { notify('This sound could not play. Open parent controls to record it again.'); }
}
function visual(item, url) {
  if (url) { const img=document.createElement('img'); img.src=url; img.alt=''; img.draggable=false; return img; }
  const emoji=document.createElement('span'); emoji.className='tile-emoji'; emoji.textContent=item.emoji || '☺'; return emoji;
}
function flash(item, url) {
  const el=$('#flash'); el.replaceChildren(visual(item,url)); el.style.setProperty('--tile-color',item.color);
  el.hidden=false; clearTimeout(flashTimer); flashTimer=setTimeout(()=>{el.hidden=true;el.replaceChildren();},400);
}
let settingsTab='play', swapTarget=null;
const activeItems=()=>board.filter(item=>item.active!==false);
const customItems=()=>board.filter(item=>!TinyLibrary.isLibrary(item));
const renderPhotos=new Map();
function photoFor(item){
  if(!item.photo)return null;
  if(!renderPhotos.has(item.id)){const url=URL.createObjectURL(item.photo);renderPhotos.set(item.id,url);urls.push(url);}
  return renderPhotos.get(item.id);
}
function showSettingsTab(name,focus=false){
  settingsTab=name;
  for(const key of ['play','library','custom']){
    const selected=key===name;$('#tab-'+key).setAttribute('aria-selected',String(selected));$('#tab-'+key).tabIndex=selected?0:-1;$('#panel-'+key).hidden=!selected;
  }
  const counts=TinyLibrary.counts(board);
  $('#settings-heading').textContent={play:'On the play screen',library:'The sound library',custom:'Your recordings'}[name];
  $('#count').textContent=name==='play'?`${counts.active} / 12`:name==='library'?'25 included':`${counts.custom} / 25`;
  $('#collection-helper').textContent={play:'Keep 12 favorites on play. Swap them whenever you like.',library:'25 familiar sounds, ready to play. All available offline.',custom:'Save your family favorites here, even when the play screen is full.'}[name];
  if(focus)$('#tab-'+name).focus();
}
function requestDelete(item){
  if(TinyLibrary.isLibrary(item))return;
  deleteId=item.id;$('#delete-description').textContent=`Delete “${item.name}” from your collection and synced devices?`;
  $('#delete-error').hidden=true;$('#delete-dialog').showModal();$('#keep').focus();
}
function render(){
  urls.forEach(url=>URL.revokeObjectURL(url));urls=[];renderPhotos.clear();
  const grid=$('#grid'),list=$('#edit-list'),active=activeItems();grid.replaceChildren();list.replaceChildren();
  grid.style.setProperty('--rows',Math.max(1,Math.ceil(active.length/2)));
  active.forEach((item,index)=>{
    const url=photoFor(item),tile=document.createElement('button');tile.type='button';tile.className='sound-tile'+(url?' has-photo':'');
    tile.style.setProperty('--tile-color',item.color);tile.setAttribute('aria-label',`Play ${item.name}`);tile.append(visual(item,url));
    const name=document.createElement('span');name.className='tile-name';name.textContent=item.name;tile.append(name);
    tile.addEventListener('pointerdown',event=>{if(event.button!==0||event.isPrimary===false)return;event.preventDefault();flash(item,url);playSound(item);});
    tile.addEventListener('click',event=>{if(event.detail===0){flash(item,url);playSound(item);}});grid.append(tile);
    const card=document.createElement('article');card.className='edit-card';card.dataset.id=item.id;card.style.setProperty('--tile-color',item.color);
    const edit=document.createElement('button');edit.type='button';edit.className='card-edit';edit.setAttribute('aria-label',`Edit ${item.name}`);
    const thumb=document.createElement('span');thumb.className='card-thumb';thumb.append(visual(item,url));
    const title=document.createElement('span');title.className='card-title';title.textContent=item.name;
    const detail=document.createElement('span');detail.className='card-detail';detail.textContent=TinyLibrary.isLibrary(item)?'From the sound library':'Made by your family';
    edit.append(thumb,title,detail);edit.onclick=()=>openEditor(item);edit.disabled=TinyLibrary.isLibrary(item)&&customItems().length>=MAX_CUSTOM;edit.title=edit.disabled?'Remove a custom recording to make room for a personalized copy.':'';card.append(edit);
    const controls=document.createElement('div');controls.className='card-controls';
    const handle=iconButton('⠿',`Drag ${item.name} to reorder`);handle.classList.add('drag-handle');handle.addEventListener('pointerdown',event=>startDrag(event,item.id,card));
    const move=document.createElement('div');move.className='move-controls';const up=iconButton('←',`Move ${item.name} up`),down=iconButton('→',`Move ${item.name} down`);
    up.disabled=index===0;down.disabled=index===active.length-1;up.onclick=()=>reorder(item.id,index-1);down.onclick=()=>reorder(item.id,index+1);move.append(up,down);
    const remove=iconButton('−',`Remove ${item.name} from play`);remove.onclick=()=>togglePlay(item.id);controls.append(handle,move,remove);card.append(controls);list.append(card);
  });
  if(!active.length){const empty=document.createElement('p');empty.className='empty-play';empty.innerHTML='<span aria-hidden="true">✳</span>Hold the gear to choose sounds for play.';grid.append(empty);list.textContent='Choose favorites from Sound library or Your recordings.';}
  $('#active-tab-count').textContent=active.length;$('#custom-tab-count').textContent=customItems().length;
  $('#add').disabled=!storageOK||customItems().length>=MAX_CUSTOM;$('#add').title=customItems().length>=MAX_CUSTOM?'Your 25 custom sound spaces are full. Remove a recording to add another.':'';
  renderSavedCollections();showSettingsTab(settingsTab);
  const keep=new Set(active.map(item=>item.id));keep.add('preview');for(const id of buffers.keys())if(!keep.has(id))buffers.delete(id);
}
function savedCard(item,library){
  const card=document.createElement('article');card.className='saved-card';card.dataset.id=item.id;card.style.setProperty('--tile-color',item.color);
  const preview=document.createElement('button');preview.type='button';preview.className='saved-preview';preview.setAttribute('aria-label',`Preview ${item.name}`);const image=visual(item,photoFor(item));if(image.tagName==='IMG')image.loading='lazy';preview.append(image);preview.onclick=()=>{$('#library-preview-status').textContent=`Previewing ${item.name}`;playSound(item);};
  const title=document.createElement('h3');title.className='saved-name';title.textContent=item.name;
  const subtitle=document.createElement('p');subtitle.className='saved-detail';subtitle.textContent=item.active!==false?'On the play screen':library?TinyLibrary.byKey.get(item.catalogKey).category:'Saved in your collection';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='saved-toggle'+(item.active!==false?' selected':'');toggle.setAttribute('aria-label',`Use ${item.name} on play screen`);toggle.setAttribute('aria-pressed',String(item.active!==false));toggle.textContent=item.active!==false?'✓ On play':'+ Add to play';toggle.disabled=!storageOK;toggle.onclick=()=>togglePlay(item.id);
  const actions=document.createElement('div');actions.className='saved-actions';
  const edit=document.createElement('button');edit.type='button';edit.className='text-button';edit.textContent=library?'Make it yours':'Edit';edit.setAttribute('aria-label',`${library?'Customize':'Edit'} ${item.name}`);edit.onclick=()=>openEditor(item);edit.disabled=library&&customItems().length>=MAX_CUSTOM;edit.title=edit.disabled?'Remove a custom recording to make room for a personalized copy.':'';actions.append(edit);
  if(!library){const remove=iconButton('×',`Delete ${item.name}`);remove.onclick=()=>requestDelete(item);actions.append(remove);}
  card.append(preview,title,subtitle,toggle,actions);return card;
}
function renderSavedCollections(){
  const list=$('#library-list'),custom=$('#custom-list');list.replaceChildren();custom.replaceChildren();
  const query=$('#library-search').value.trim().toLowerCase(),category=$('#library-category').value;
  for(const definition of TinyLibrary.definitions){
    if(query&&!definition.name.toLowerCase().includes(query))continue;if(category!=='All'&&definition.category!==category)continue;
    const item=board.find(item=>TinyLibrary.isLibrary(item)&&item.catalogKey===definition.key);if(item)list.append(savedCard(item,true));
  }
  if(!list.childElementCount)list.textContent='No familiar sounds found. Try another name or category.';
  for(const item of customItems())custom.append(savedCard(item,false));
  if(!custom.childElementCount)custom.textContent='Your family sounds will live here. Add a photo and a recording to get started.';
}
function iconButton(text,label){const el=document.createElement('button');el.type='button';el.className='icon-button';el.textContent=text;el.setAttribute('aria-label',label);return el;}
async function commitCollection(next){
  if(busyBoard||saving)return;busyBoard=true;
  try{await writeBoard(next);board=next;render();Promise.allSettled(activeItems().map(decodeSound));return true;}
  catch(error){notify(storageMessage(error));return false;}finally{busyBoard=false;}
}
async function reorder(id,target){
  const active=activeItems(),from=active.findIndex(item=>item.id===id);if(from<0||from===target||target<0||target>=active.length)return;
  active.splice(target,0,active.splice(from,1)[0]);let index=0;await commitCollection(board.map(item=>item.active!==false?active[index++]:item));
}
async function togglePlay(id){
  if(busyBoard||saving)return;const item=board.find(item=>item.id===id);if(!item)return;
  if(item.active!==false){await commitCollection(board.map(old=>old.id===id?{...old,active:false}:old));return;}
  if(activeItems().length>=MAX_BUTTONS){openSwap(item);return;}
  await commitCollection([...board.filter(old=>old.id!==id),{...item,active:true}]);
}
function openSwap(item){
  swapTarget=item.id;$('#swap-title').textContent=`Make room for ${item.name}`;$('#swap-description').textContent='Choose a sound to swap out. It stays in your collection for another day.';$('#swap-error').hidden=true;
  const options=$('#swap-options');options.replaceChildren();
  for(const current of activeItems()){
    const button=document.createElement('button');button.type='button';button.className='swap-option';button.style.setProperty('--tile-color',current.color);button.setAttribute('aria-label',`Replace ${current.name} with ${item.name}`);button.append(visual(current,photoFor(current)));const label=document.createElement('span');label.textContent=current.name;button.append(label);
    button.onclick=async()=>{
      if(busyBoard)return;const target=board.find(old=>old.id===swapTarget);if(!target)return;
      const next=board.filter(old=>old.id!==target.id).map(old=>old.id===current.id?{...old,active:false}:old),index=next.findIndex(old=>old.id===current.id);next.splice(index,0,{...target,active:true});
      if(await commitCollection(next)){$('#swap-dialog').close();swapTarget=null;notify(`${item.name} is on play. ${current.name} is saved in your collection.`);}
    };options.append(button);
  }
  $('#swap-dialog').showModal();
}
function startDrag(event,id,card) {
  if(event.button!==0 || busyBoard)return;
  event.preventDefault();const handle=event.currentTarget;handle.setPointerCapture(event.pointerId);card.classList.add('dragging');
  let target=null;
  const move=e=>{
    document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));
    target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.edit-card');
    if(target && target!==card)target.classList.add('drop-target');
  };
  const finish=e=>{
    handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',cancel);
    card.classList.remove('dragging');document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));
    if(e.type==='pointerup'&&target&&target!==card)reorder(id,activeItems().findIndex(item=>item.id===target.dataset.id));
  };
  const cancel=e=>finish(e);
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',cancel);
}

let holdTimer,holdOrigin=null,holdPointer=null;
function cancelHold() {clearTimeout(holdTimer);holdTimer=null;holdOrigin=null;holdPointer=null;$('#gear').classList.remove('holding');}
function beginHold(event) {
  if(!initialized || holdTimer)return;
  if(event.type==='pointerdown'){
    if(event.button!==0||event.isPrimary===false)return;
    event.preventDefault();holdOrigin={x:event.clientX,y:event.clientY};holdPointer=event.pointerId;
    // Synthetic events used by accessibility tools need not have an active pointer.
    try{$('#gear').setPointerCapture(event.pointerId);}catch{}
  }
  $('#gear').classList.add('holding');holdTimer=setTimeout(()=>{
    cancelHold();stopSound();$('#flash').hidden=true;$('#parents').hidden=false;$('#gear').hidden=true;$('#play').inert=true;$('#back').focus();
  },3000);
}
$('#gear').addEventListener('pointerdown',beginHold);
$('#gear').addEventListener('pointermove',e=>{if(holdOrigin&&Math.hypot(e.clientX-holdOrigin.x,e.clientY-holdOrigin.y)>16)cancelHold();});
for(const type of ['pointerup','pointercancel','lostpointercapture','blur'])$('#gear').addEventListener(type,cancelHold);
$('#gear').addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();beginHold(e);}});
$('#gear').addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter')cancelHold();});
$('#gear').addEventListener('contextmenu',e=>e.preventDefault());
$('#back').onclick=()=>{$('#parents').hidden=true;$('#gear').hidden=false;$('#play').inert=false;stopSound();$('#gear').focus();};
$('#add').onclick=()=>{showSettingsTab('custom');openEditor();};
for(const [index,key] of ['play','library','custom'].entries()){
  $('#tab-'+key).onclick=()=>showSettingsTab(key);
  $('#tab-'+key).onkeydown=e=>{const keys=['play','library','custom'];let next;if(e.key==='ArrowRight')next=(index+1)%3;if(e.key==='ArrowLeft')next=(index+2)%3;if(e.key==='Home')next=0;if(e.key==='End')next=2;if(next!==undefined){e.preventDefault();showSettingsTab(keys[next],true);}};
}
$('#library-search').oninput=renderSavedCollections;$('#library-category').onchange=renderSavedCollections;
$('#cancel-swap').onclick=()=>{if(!busyBoard)$('#swap-dialog').close();};$('#swap-dialog').addEventListener('cancel',e=>{if(busyBoard)e.preventDefault();});

function updatePhotoPreview() {
  if(photoURL)URL.revokeObjectURL(photoURL);photoURL=draft.photo?URL.createObjectURL(draft.photo):null;
  $('#photo-preview').replaceChildren(visual(draft,photoURL));
}
function openEditor(item) {
  editorSession++;draft=item?{...item}:{id:crypto.randomUUID(),name:'',emoji:'☺',color:COLORS[board.length%COLORS.length],photo:null,audio:null,demo:false,kind:'custom',catalogKey:null,active:activeItems().length<MAX_BUTTONS};
  $('#editor-title').textContent=item?'A little update':'Add a sound';$('#name').value=draft.name;
  $('#photo-file').value='';$('#camera-file').value='';$('#record-label').textContent='Record sound';$('#record-time').textContent='Up to 15 seconds';
  $('#record').classList.remove('recording');$('#record').disabled=false;$('#preview').hidden=!draft.audio;
  $('#record-help').textContent='A woof, a hello, a little giggle. Make it yours.';$('#save').disabled=false;
  $('#editor-active').checked=draft.active!==false;$('#editor-active').disabled=activeItems().length>=MAX_BUTTONS&&draft.active===false;
  $('#editor-play-help').textContent=$('#editor-active').disabled?'The play screen is full. Save it here, then choose a sound to swap out.':TinyLibrary.isLibrary(draft)?'Personalizing a library sound saves a custom copy. The original stays in the library.':'Saved sounds can be swapped onto play whenever you like.';
  editorError();updatePhotoPreview();$('#editor').showModal();
}
function closeEditor() {
  if(saving)return;
  editorSession++;cleanupRecording();draft=null;buffers.delete('preview');if(photoURL)URL.revokeObjectURL(photoURL);photoURL=null;
  photoPending=false;$('#editor').close();stopSound();
}
$('.close-editor').onclick=closeEditor;document.querySelectorAll('.close-editor').forEach(el=>el.onclick=closeEditor);
$('#editor').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
$('#pick-photo').onclick=()=>$('#photo-file').click();$('#take-photo').onclick=()=>$('#camera-file').click();
async function choosePhoto(event) {
  const file=event.target.files[0];if(!file)return;
  const session=editorSession;photoPending=true;$('#save').disabled=true;editorError();
  let imageURL;
  try{
    if(file.size>20*1024*1024)throw new Error('Choose a photo smaller than 20 MB.');
    imageURL=URL.createObjectURL(file);const image=new Image();image.src=imageURL;await image.decode();
    const scale=Math.min(1,1024/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#f6f2e9';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));if(!blob)throw new Error('This photo could not be processed. Try another photo.');
    if(session!==editorSession)return;draft.photo=blob;updatePhotoPreview();
  }catch(error){if(session===editorSession)editorError(error.message==='The source image cannot be decoded.'?'Could not open this photo. Try a JPEG or PNG.':error.message);}
  finally{if(imageURL)URL.revokeObjectURL(imageURL);if(session===editorSession){photoPending=false;$('#save').disabled=false;}}
}
$('#photo-file').onchange=choosePhoto;$('#camera-file').onchange=choosePhoto;
function releaseMicrophone(){if(stream)stream.getTracks().forEach(track=>track.stop());stream=null;}
function cleanupRecording() {
  clearInterval(recordTimer);recordingPending=false;
  if(recorder){recorder.ondataavailable=null;recorder.onstop=null;recorder.onerror=null;if(recorder.state!=='inactive')recorder.stop();recorder=null;}
  releaseMicrophone();
}
function stopRecording(){if(recorder?.state==='recording'){$('#record').disabled=true;$('#record-label').textContent='Finishing…';recorder.stop();clearInterval(recordTimer);}}
$('#record').onclick=async()=>{
  if(recorder?.state==='recording'){stopRecording();return;}
  if(recordingPending)return;
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){editorError('Recording needs a supported browser on HTTPS or localhost. Try current Safari or Chrome.');return;}
  const session=editorSession;recordingPending=true;$('#record').disabled=true;$('#save').disabled=true;editorError();stopSound();
  $('#record-help').textContent='Allow microphone access when your browser asks.';
  try{
    const captured=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false}});
    if(session!==editorSession){captured.getTracks().forEach(t=>t.stop());return;}
    stream=captured;
    const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
    const active=new MediaRecorder(stream,type?{mimeType:type}:undefined);recorder=active;
    const chunks=[];active.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    active.onerror=()=>{if(session===editorSession){cleanupRecording();$('#record').disabled=false;$('#record').classList.remove('recording');$('#record-label').textContent='Record sound';$('#save').disabled=false;editorError('Recording failed. Your previous sound is unchanged. Please try again.');}};
    active.onstop=async()=>{
      clearInterval(recordTimer);releaseMicrophone();recorder=null;
      if(session!==editorSession)return;
      try{
        const blob=new Blob(chunks,{type:active.mimeType || chunks[0]?.type});
        if(!blob.size)throw new Error('No sound was captured. Please record again.');
        buffers.delete('preview');await decodeSound({id:'preview',audio:blob});
        if(session!==editorSession){buffers.delete('preview');return;}
        draft.audio=blob;draft.demo=false;$('#preview').hidden=false;$('#record-help').textContent='Sounds good? Preview it, or record again.';
      }catch{if(session===editorSession)editorError('Could not read this recording. Please record again.');}
      finally{if(session===editorSession){recordingPending=false;$('#record').disabled=false;$('#save').disabled=false;$('#record').classList.remove('recording');$('#record-label').textContent='Record again';}}
    };
    active.start();recordStarted=performance.now();$('#record').disabled=false;$('#record').classList.add('recording');$('#record-label').textContent='Stop recording';$('#preview').hidden=true;
    $('#record-help').textContent='Listening… tap stop when you’re done.';
    const tick=()=>{const elapsed=(performance.now()-recordStarted)/1000;$('#record-time').textContent=`${Math.min(15,Math.floor(elapsed))} / 15 seconds`;if(elapsed>=15)stopRecording();};
    tick();recordTimer=setInterval(tick,200);
  }catch(error){
    releaseMicrophone();if(session!==editorSession)return;
    recordingPending=false;$('#record').disabled=false;$('#save').disabled=false;$('#record-help').textContent='A woof, a hello, a little giggle. Make it yours.';
    editorError(error.name==='NotAllowedError'?'Microphone access was not allowed. Enable it in your browser’s site settings, then try again.':error.name==='NotFoundError'?'No microphone found. Connect one and try again.':'Could not start recording. Check your microphone and try again.');
  }
};
$('#preview').onclick=()=>{if(draft?.audio)playSound({id:'preview',audio:draft.audio});};
$('#editor-form').onsubmit=async event=>{
  event.preventDefault();if(saving||photoPending||recordingPending||busyBoard)return;editorError();
  const name=$('#name').value.trim();if(!name){editorError('Give this button a name.');$('#name').focus();return;}
  if(!draft.photo&&!board.some(item=>item.id===draft.id)){editorError('Choose or take a photo first.');return;}
  if(!draft.audio){editorError('Record a sound first.');return;}
  const original=board.find(item=>item.id===draft.id),library=original&&TinyLibrary.isLibrary(original);
  const personalized=library&&(name!==original.name||draft.photo!==original.photo||draft.audio!==original.audio);
  const customNew=!original||personalized;
  if(customNew&&customItems().length>=MAX_CUSTOM){editorError('Your 25 custom sound spaces are full. Delete a saved recording before adding another.');return;}
  const active=$('#editor-active').checked;
  const item={...draft,name,active,...(personalized?{id:crypto.randomUUID(),kind:'custom',catalogKey:null,demo:false}:{})};
  const next=personalized?board.flatMap(old=>old.id===original.id?[{...old,active:false},item]:[old]):original?board.map(old=>old.id===item.id?item:old):[...board,item];
  if(next.filter(item=>item.active!==false).length>MAX_BUTTONS){editorError('The play screen has 12 sounds. Save this one with Show on the play screen unchecked, then swap it in.');return;}
  saving=true;$('#save').disabled=true;
  try{
    await writeBoard(next);board=next;buffers.delete(item.id);await decodeSound(item).catch(()=>{});render();
    saving=false;closeEditor();navigator.storage?.persist?.().catch(()=>{});
  }catch(error){editorError(storageMessage(error));}finally{saving=false;$('#save').disabled=false;}
};
$('#keep').onclick=()=>$('#delete-dialog').close();
$('#confirm-delete').onclick=async()=>{
  if(busyBoard)return;busyBoard=true;$('#confirm-delete').disabled=true;$('#keep').disabled=true;
  try{const next=board.filter(item=>item.id!==deleteId);await writeBoard(next);buffers.delete(deleteId);board=next;render();$('#delete-dialog').close();}
  catch(error){$('#delete-error').textContent=storageMessage(error);$('#delete-error').hidden=false;}
  finally{busyBoard=false;$('#confirm-delete').disabled=false;$('#keep').disabled=false;}
};
$('#delete-dialog').addEventListener('cancel',e=>{if(busyBoard)e.preventDefault();});
window.addEventListener('resize',()=>{if(initialized)render();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelHold();stopSound();if(recorder?.state==='recording')stopRecording();}});
window.addEventListener('pagehide',()=>{
  cancelHold();stopSound();editorSession++;cleanupRecording();photoPending=false;
  if(draft){
    $('#record').disabled=saving;$('#save').disabled=saving;$('#record').classList.remove('recording');
    $('#record-label').textContent='Record sound';$('#record-time').textContent='Up to 15 seconds';$('#preview').hidden=!draft.audio;
    $('#record-help').textContent='Ready when you are. Record again if your last take was interrupted.';
  }
});
window.addEventListener('blur',cancelHold);
document.addEventListener('contextmenu',e=>{if($('#parents').hidden)e.preventDefault();});
// The play surface does not scroll, bounce, select text, or trigger pull-to-refresh.
document.addEventListener('touchmove',e=>{if($('#parents').hidden)e.preventDefault();},{passive:false});
async function setupOffline() {
  const status=$('#offline-status');
  if(!('serviceWorker' in navigator)){status.textContent='Offline installation is unavailable in this browser.';return;}
  try{
    await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;
    const update=()=>status.textContent=storageOK?(navigator.onLine?'Ready for offline play · 12 on play, 50 in your collection':'Offline & ready to play'):'Device storage unavailable. Changes cannot be saved.';
    update();window.addEventListener('online',update);window.addEventListener('offline',update);
  }catch{status.textContent='Offline setup failed. Open on HTTPS or localhost, then reload.';}
}
(async()=>{
  try{
    db=await openDatabase();storageOK=true;const saved=await readBoard();
    if(saved===undefined){board=defaultBoard();await writeBoard(board,{system:true});}else {
      board=upgradeDemoSounds(saved);
      if(board.some((item,index)=>item!==saved[index]))await writeBoard(board,{system:true});
    }
  }catch(error){storageOK=false;if(!board.length)board=defaultBoard();notify('Device storage is unavailable. Demo play works, but changes cannot be saved.');}
  // Decode before showing the board, avoiding a decoding delay on the first tap.
  await Promise.allSettled(board.filter(item=>item.active!==false).map(decodeSound));initialized=true;render();setupOffline();
  if(storageOK)window.TinySoundsSync?.start(syncAdapter).catch(()=>{ $('#sync-status').textContent='Sync could not start. Your saved board still plays on this device.'; });
  else { $('#sync-status').textContent='Enable device storage to use private sync.';$('#sync-login').inert=true; }
})();
