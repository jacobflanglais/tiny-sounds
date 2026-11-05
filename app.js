'use strict';
const $ = (selector) => document.querySelector(selector);
const COLORS = ['#e1e9c9', '#edd9ca', '#f1e5b8', '#cbdde4', '#e2d6e8', '#d6e5dc'];
// A small board keeps every tile finger-sized without a scrolling play screen.
const MAX_BUTTONS = 12;
const DB_NAME = 'tiny-sounds';
let db, boardRevision = 0, board = [], urls = [], initialized = false, storageOK = false;
let audioContext, output, currentSource, playSequence = 0;
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
    const request = store.get('board'), revision = store.get('revision');
    tx.oncomplete = () => { boardRevision = revision.result || 0; resolve(request.result); };
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
function writeBoard(next) {
  return new Promise((resolve, reject) => {
    if (!db || !storageOK) return reject(new Error('Device storage is unavailable. Enable site storage, then reopen the app.'));
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    let conflict = false;
    const revision = store.get('revision');
    revision.onsuccess = () => {
      if ((revision.result || 0) !== boardRevision) { conflict = true; tx.abort(); return; }
      store.put(next, 'board'); store.put(boardRevision + 1, 'revision');
    };
    tx.oncomplete = () => { boardRevision++; resolve(); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(conflict ? new Error('Another window saved changes. Reopen this app before editing again so those changes are preserved.') : tx.error);
  });
}
function storageMessage(error) {
  return error?.name === 'QuotaExceededError' ? 'This device is out of storage. Free some space and try again. Your saved board is unchanged.' : (error?.message || 'Could not save. Your saved board is unchanged. Please try again.');
}

// Encoded recordings are bundled in demo-sounds.js and never fetched externally.
const DEMO_KEYS = {'🐶':'puppy','🐱':'kitty','🦆':'duck','🚗':'car'};
const DEMO_VERSIONS = {puppy:2,kitty:3,duck:3,car:2};
function demoAudio(key) {
  return new Blob([Uint8Array.from(atob(DEMO_SOUNDS[key]), c => c.charCodeAt(0))], {type:'audio/mpeg'});
}
function defaultBoard() {
  return ['Puppy','Kitty','Duck','Car'].map((name,i) => {
    const emoji=['🐶','🐱','🦆','🚗'][i], demoKey=DEMO_KEYS[emoji];
    return {id:crypto.randomUUID(),name,emoji,color:COLORS[i],photo:null,audio:demoAudio(demoKey),demo:true,demoKey,demoVersion:DEMO_VERSIONS[demoKey]};
  });
}
function upgradeDemoSounds(items) {
  return items.map(item => {
    const key = DEMO_KEYS[item.emoji];
    // Only old, recognizable emoji demos qualify. Personal photos/recordings are untouched.
    if (!item.demo || item.photo || !key || item.demoVersion === DEMO_VERSIONS[key]) return item;
    return {...item,audio:demoAudio(key),demoKey:key,demoVersion:DEMO_VERSIONS[key]};
  });
}
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
function render() {
  urls.forEach(url=>URL.revokeObjectURL(url)); urls=[];
  const grid=$('#grid'), list=$('#edit-list'); grid.replaceChildren(); list.replaceChildren();
  grid.style.setProperty('--rows',Math.max(1,Math.ceil(board.length/2)));
  board.forEach((item,index)=>{
    const url=item.photo?URL.createObjectURL(item.photo):null; if(url)urls.push(url);
    const tile=document.createElement('button');tile.type='button';tile.className='sound-tile'+(url?' has-photo':'');
    tile.style.setProperty('--tile-color',item.color); tile.setAttribute('aria-label',`Play ${item.name}`);
    tile.append(visual(item,url)); const name=document.createElement('span');name.className='tile-name';name.textContent=item.name;tile.append(name);
    tile.addEventListener('pointerdown',event=>{if(event.button!==0 || event.isPrimary===false)return;event.preventDefault();flash(item,url);playSound(item);});
    tile.addEventListener('click',event=>{if(event.detail===0){flash(item,url);playSound(item);}});
    grid.append(tile);
    const card=document.createElement('article');card.className='edit-card';card.dataset.id=item.id;card.style.setProperty('--tile-color',item.color);
    const edit=document.createElement('button');edit.type='button';edit.className='card-edit';edit.setAttribute('aria-label',`Edit ${item.name}`);
    const thumb=document.createElement('span');thumb.className='card-thumb';thumb.append(visual(item,url));
    const title=document.createElement('span');title.className='card-title';title.textContent=item.name;
    const detail=document.createElement('span');detail.className='card-detail';detail.textContent=item.demo?'A little demo sound':'Made by your family';
    edit.append(thumb,title,detail);edit.onclick=()=>openEditor(item);card.append(edit);
    const controls=document.createElement('div');controls.className='card-controls';
    const handle=iconButton('⠿',`Drag ${item.name} to reorder`);handle.classList.add('drag-handle');
    handle.addEventListener('pointerdown',event=>startDrag(event,item.id,card));
    const move=document.createElement('div');move.className='move-controls';
    const up=iconButton('←',`Move ${item.name} up`),down=iconButton('→',`Move ${item.name} down`);
    up.disabled=index===0;down.disabled=index===board.length-1;
    up.onclick=()=>reorder(item.id,index-1);down.onclick=()=>reorder(item.id,index+1);move.append(up,down);
    const remove=iconButton('×',`Delete ${item.name}`);remove.onclick=()=>{
      deleteId=item.id;$('#delete-description').textContent=`Remove “${item.name}” from your soundboard?`;
      $('#delete-error').hidden=true;$('#delete-dialog').showModal();$('#keep').focus();
    };
    controls.append(handle,move,remove);card.append(controls);list.append(card);
  });
  if(!board.length){const empty=document.createElement('p');empty.className='empty-play';empty.innerHTML='<span aria-hidden="true">✳</span>Hold the gear to add your first sound.';grid.append(empty);list.textContent='A little quiet here. Add your first familiar face.';}
  $('#count').textContent=board.length;
  $('#add').disabled=!storageOK||board.length>=MAX_BUTTONS;
  $('#add').title=board.length>=MAX_BUTTONS?'12 sounds keeps every button big enough for little hands.':'';
}
function iconButton(text,label) {const el=document.createElement('button');el.type='button';el.className='icon-button';el.textContent=text;el.setAttribute('aria-label',label);return el;}
async function reorder(id,target) {
  if(busyBoard)return;const next=[...board],from=next.findIndex(item=>item.id===id);
  if(from<0||from===target||target<0||target>=next.length)return;
  next.splice(target,0,next.splice(from,1)[0]);busyBoard=true;
  try{await writeBoard(next);board=next;render();}catch(error){notify(storageMessage(error));}finally{busyBoard=false;}
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
    if(e.type==='pointerup'&&target&&target!==card)reorder(id,board.findIndex(item=>item.id===target.dataset.id));
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
$('#add').onclick=()=>openEditor();

function updatePhotoPreview() {
  if(photoURL)URL.revokeObjectURL(photoURL);photoURL=draft.photo?URL.createObjectURL(draft.photo):null;
  $('#photo-preview').replaceChildren(visual(draft,photoURL));
}
function openEditor(item) {
  editorSession++;draft=item?{...item}:{id:crypto.randomUUID(),name:'',emoji:'☺',color:COLORS[board.length%COLORS.length],photo:null,audio:null,demo:false};
  $('#editor-title').textContent=item?'A little update':'Add a sound';$('#name').value=draft.name;
  $('#photo-file').value='';$('#camera-file').value='';$('#record-label').textContent='Record sound';$('#record-time').textContent='Up to 15 seconds';
  $('#record').classList.remove('recording');$('#record').disabled=false;$('#preview').hidden=!draft.audio;
  $('#record-help').textContent='A woof, a hello, a little giggle. Make it yours.';$('#save').disabled=false;
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
  const item={...draft,name};const exists=board.some(el=>el.id===item.id);
  if(!exists&&board.length>=MAX_BUTTONS){editorError('Your board is full. Remove a button before adding another.');return;}
  const next=exists?board.map(el=>el.id===item.id?item:el):[...board,item];
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
    const update=()=>status.textContent=storageOK?(navigator.onLine?'Ready for offline play · up to 12 sounds':'Offline & ready to play'):'Device storage unavailable. Changes cannot be saved.';
    update();window.addEventListener('online',update);window.addEventListener('offline',update);
  }catch{status.textContent='Offline setup failed. Open on HTTPS or localhost, then reload.';}
}
(async()=>{
  try{
    db=await openDatabase();storageOK=true;const saved=await readBoard();
    if(saved===undefined){board=defaultBoard();await writeBoard(board);}else {
      board=upgradeDemoSounds(saved);
      if(board.some((item,index)=>item!==saved[index]))await writeBoard(board);
    }
  }catch(error){storageOK=false;if(!board.length)board=defaultBoard();notify('Device storage is unavailable. Demo play works, but changes cannot be saved.');}
  // Decode before showing the board, avoiding a decoding delay on the first tap.
  await Promise.allSettled(board.map(decodeSound));initialized=true;render();setupOffline();
})();
