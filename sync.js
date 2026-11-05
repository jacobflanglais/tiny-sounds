'use strict';
// Private cloud manifests + immutable media; local IndexedDB remains the play source.
window.TinySoundsSync = (() => {
  const el = id => document.getElementById(id);
  const BUCKET = 'tiny-sounds-media';
  let api, adapter, session = null, running = false, timer, conflict = null, authBusy = false, generation = 0;
  let recovery = false, muted = false;
  const mediaPaths = items => new Set(items.flatMap(item => [item.audio?.path,item.photo?.path].filter(Boolean)));
  const offline = () => !navigator.onLine;
  const isLocalBusy = () => adapter?.busy() || false;
  const message = text => { el('sync-status').textContent = text; };
  const error = text => { el('sync-error').textContent = text || ''; el('sync-error').hidden = !text; };
  const fail = (text,code) => Object.assign(new Error(text),{code});
  function describe(err) {
    if(offline() || err?.message?.match(/fetch|network|abort|timeout/i)) return 'Saved on this device. Sync will retry when your connection returns.';
    if(err?.code==='LOCAL_CHANGED' || err?.code==='LOCAL_BUSY') return 'Your latest changes are saved here. Sync will retry shortly.';
    if(err?.status===403 || err?.statusCode==='403') return 'Sync access or storage limit reached. Your board is still saved on this device.';
    if(err?.status===401 || /JWT|refresh token|session|sign in/i.test(err?.message || '')) return 'Please sign in again to continue syncing. Your local board is safe.';
    return err?.message || 'Could not sync. Your board is still saved on this device.';
  }
  function controls() {
    const signed = Boolean(session);
    el('sync-login').hidden = signed || recovery;
    el('sync-connected').hidden = !signed || recovery;
    el('sync-recovery').hidden = !recovery;
    el('sync-account').textContent = signed ? `Signed in as ${session.user.email || 'your account'}` : '';
    el('sync-conflict').hidden = !conflict || !signed;
    for(const id of ['sync-now','sync-use-local','sync-use-cloud','sync-sign-out','sync-restore']) el(id).disabled = running || authBusy;
    for(const id of ['sync-sign-in','sync-sign-up','sync-google','sync-forgot']) el(id).disabled = authBusy;
    el('sync-badge').textContent = signed ? (offline()?'Offline copy':conflict?'Choose a board':running?'Syncing…':'Private sync') : 'On this device';
  }
  function schedule(delay=700) {
    clearTimeout(timer); if(!adapter || !session || recovery || muted)return;
    timer=setTimeout(()=>cycle(),delay);
  }
  function snapshotStill(snap,gen,userId) {
    return gen===generation && session?.user.id===userId && adapter.snapshot().revision===snap.revision;
  }
  async function readCloud() {
    const {data,error:err}=await api.from('tiny_sound_boards').select('revision,items,updated_at').eq('user_id',session.user.id).maybeSingle();
    if(err)throw err;return data;
  }
  function validateManifest(items,userId) {
    if(!Array.isArray(items)||items.length>12)throw fail('The account board is not a supported Tiny Sounds board.');
    const ids=new Set();
    return items.map(item=>{
      if(typeof item.id!=='string'||!/^[0-9a-f-]{36}$/i.test(item.id)||ids.has(item.id)||typeof item.name!=='string'||!item.name.trim()||item.name.length>32||!/^#[0-9a-f]{6}$/i.test(item.color)||typeof item.emoji!=='string'||item.emoji.length>16)throw fail('An account button could not be read. Your local board is unchanged.');
      ids.add(item.id);
      for(const file of [item.audio,item.photo].filter(Boolean)){
        if(typeof file.path!=='string'||!new RegExp(`^${userId}/[0-9a-f]{64}\\.bin$`).test(file.path)||typeof file.type!=='string'||!/^(audio\/[a-z0-9.+-]+|image\/jpeg)(;.*)?$/i.test(file.type))throw fail('An account recording or photo could not be read.');
      }
      if(!item.audio)throw fail('An account button is missing its recording.');
      return {...item};
    });
  }
  async function decodeCloud(remote,local) {
    const userId=session.user.id;
    const items=validateManifest(remote.items,userId), cache=new Map();
    for(const item of local.items)for(const blob of [item.audio,item.photo].filter(Boolean)){
      if(blob instanceof Blob)cache.set(await filePath(blob,userId),blob);
    }
    async function download(info){
      if(!info)return null;if(cache.has(info.path))return cache.get(info.path);
      const {data,error:err}=await api.storage.from(BUCKET).download(info.path);if(err)throw err;
      if(data.size>5242880)throw fail('A synced file exceeds the supported size.');
      const blob=new Blob([data],{type:info.type});
      if(await filePath(blob,userId)!==info.path)throw fail('A synced file did not pass its integrity check. Please sync again.');
      cache.set(info.path,blob);return blob;
    }
    const result=[];
    for(const item of items)result.push({...item,audio:await download(item.audio),photo:await download(item.photo)});
    return result;
  }
  async function filePath(blob,userId) {
    const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return `${userId}/${[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}.bin`;
  }
  async function encodeLocal(items,remote,uploaded) {
    const userId=session.user.id;
    const known=mediaPaths(remote?.items || []), result=[];
    async function upload(blob){
      if(!(blob instanceof Blob)||!blob.size||blob.size>5242880)throw fail('A photo or recording is too large to sync (5 MB maximum per file).');
      const path=await filePath(blob,userId),type=blob.type || 'audio/webm';
      if(session?.user.id!==userId)throw fail('Sign-in changed during sync.','LOCAL_CHANGED');
      if(!known.has(path)){
        const {error:err}=await api.storage.from(BUCKET).upload(path,blob,{contentType:type.split(';')[0],upsert:false,cacheControl:'3600'});
        if(err && String(err.statusCode || err.status)!=='409' && !/already exists|duplicate/i.test(err.message))throw err;
        known.add(path);uploaded.add(path);
      }
      return {path,type};
    }
    for(const item of items){
      const audio=await upload(item.audio),photo=item.photo?await upload(item.photo):null;
      result.push({id:item.id,name:item.name,emoji:item.emoji||'☺',color:item.color,demo:Boolean(item.demo),demoKey:item.demoKey||null,demoVersion:item.demoVersion||null,audio,photo});
    }
    return result;
  }
  async function cleanup(oldItems,newItems) {
    const used=mediaPaths(newItems), retired=[...mediaPaths(oldItems || [])].filter(path=>!used.has(path));
    // Server policies refuse to delete anything referenced by the latest account board.
    if(retired.length)await api.storage.from(BUCKET).remove(retired);
  }
  async function takeCloud(remote,snap,backup,gen,userId) {
    const items=remote?await decodeCloud(remote,snap):[];
    if(!snapshotStill(snap,gen,userId))throw fail('This device changed while syncing.','LOCAL_CHANGED');
    await adapter.replace(items,{owner:userId,remoteRevision:remote?.revision||0,dirty:false},snap.revision,backup?snap.items:null);
    conflict=null;error('');message('Up to date. Your buttons are available on your signed-in devices.');
  }
  async function pruneOrphans(remoteItems,userId) {
    const referenced=mediaPaths(remoteItems || []), files=[];
    for(let page=0;page<10;page++){
      const {data,error:err}=await api.storage.from(BUCKET).list(userId,{limit:100,offset:page*100,sortBy:{column:'name',order:'asc'}});
      if(err)throw err;
      for(const file of data)if(file.id && /^[0-9a-f]{64}\.bin$/.test(file.name))files.push(`${userId}/${file.name}`);
      if(data.length<100)break;
    }
    if(session?.user.id!==userId)throw fail('Sign-in changed during sync.','LOCAL_CHANGED');
    const paths=files.filter(path=>!referenced.has(path));
    for(let i=0;i<paths.length;i+=100){const {error:err}=await api.storage.from(BUCKET).remove(paths.slice(i,i+100));if(err)throw err;}
  }
  async function pushCloud(remote,snap,saveAlternate,gen,userId) {
    const uploaded=new Set();let committed=false;
    try{
      if(saveAlternate && remote){
        const alternate=await decodeCloud(remote,snap);
        if(!snapshotStill(snap,gen,userId))throw fail('This device changed while syncing.','LOCAL_CHANGED');
        await adapter.backup(alternate);
      }
      // Recover quota consumed by interrupted uploads, including earlier browser sessions.
      await pruneOrphans(remote?.items,userId);
      const items=await encodeLocal(snap.items,remote,uploaded);
      if(!snapshotStill(snap,gen,userId))throw fail('This device changed while syncing.','LOCAL_CHANGED');
      await adapter.checkCurrent(snap.revision);
      const {data,error:err}=await api.rpc('tiny_sounds_save_board',{p_expected_revision:remote?.revision||0,p_items:items});
      if(err){if(err.code==='PT409')throw fail('The account board changed again. Please choose a version.','CONFLICT');throw err;}
      committed=true;
      if(gen!==generation || session?.user.id!==userId)return;
      await adapter.markUploaded(snap.revision,userId,data.revision);
      conflict=null;error('');message(adapter.snapshot().meta.dirty?'Newer changes are saved here and waiting to sync.':'Up to date. Your buttons are available on your signed-in devices.');
      await cleanup(remote?.items,items).catch(()=>{});
    }finally{
      if(!committed && uploaded.size && session?.user.id===userId)await api.storage.from(BUCKET).remove([...uploaded]).catch(()=>{});
    }
  }
  function ask(remote,snap,userId) {
    conflict={remote,snapshotRevision:snap.revision,userId};
    el('sync-conflict-message').textContent=`This device has ${snap.items.length} buttons. Your account has ${remote?.items?.length||0}. Both versions will be kept until you choose.`;
    message('Choose a board below to finish syncing.');controls();
  }
  async function cycle(choice) {
    if(!adapter || !session || running || recovery || muted)return;
    if(offline()){message('Offline. Your board plays here; changes will sync when you reconnect.');controls();return;}
    if(isLocalBusy()){schedule(1500);return;}
    if(conflict && !choice){controls();return;}
    running=true;controls();
    const gen=generation,userId=session.user.id;let snap;
    try{
      await adapter.checkCurrent();snap=adapter.snapshot();
      const remote=await readCloud();
      if(!snapshotStill(snap,gen,userId))throw fail('This device changed while syncing.','LOCAL_CHANGED');
      const linked=snap.meta.owner===userId;
      if(choice==='cloud'){await takeCloud(remote,snap,true,gen,userId);}
      else if(choice==='local'){await pushCloud(remote,snap,true,gen,userId);}
      else if(!linked){
        const starters=!snap.meta.owner&&!snap.meta.dirty&&snap.items.length===4&&snap.items.every((item,index)=>item.demo&&!item.photo&&item.name===['Puppy','Kitty','Duck','Car'][index]&&item.emoji===['🐶','🐱','🦆','🚗'][index]);
        if(remote && starters)await takeCloud(remote,snap,true,gen,userId);
        else if(!remote && !snap.meta.owner)await pushCloud(remote,snap,false,gen,userId);
        else ask(remote,snap,userId);
      }else if(snap.meta.dirty){
        if((remote?.revision||0)!==(snap.meta.remoteRevision||0))ask(remote,snap,userId);
        else await pushCloud(remote,snap,false,gen,userId);
      }else if((remote?.revision||0)!==(snap.meta.remoteRevision||0))await takeCloud(remote,snap,false,gen,userId);
      else {error('');message('Up to date. Your buttons are available on your signed-in devices.');}
    }catch(err){
      if(gen===generation){
        if(err.code==='LOCAL_STALE'){muted=true;error(err.message);message('Reopen this window to sync its latest saved board.');}
        else if(err.code==='CONFLICT'){conflict=null;message(err.message);schedule(300);}
        else{error(describe(err));message('Your local board is ready to play.');}
      }
    }finally{
      running=false;controls();await refreshBackup();
      if(session&&!conflict)schedule(adapter.snapshot().meta.dirty?2500:30000);
    }
  }
  async function refreshBackup(){if(adapter)el('sync-restore').hidden=!(await adapter.hasBackup());}
  async function authenticate(mode) {
    if(authBusy)return;if(offline()){error('Connect to the internet to sign in. Your saved board still works offline.');return;}
    const email=el('sync-email').value.trim(),password=el('sync-password').value;
    if(!el('sync-email').reportValidity() || (mode!=='forgot'&&!el('sync-password').reportValidity()))return;
    authBusy=true;controls();error('');
    try{
      const redirect=new URL('./',location.href).href;
      let result;
      if(mode==='signup')result=await api.auth.signUp({email,password,options:{emailRedirectTo:redirect}});
      else if(mode==='forgot')result=await api.auth.resetPasswordForEmail(email,{redirectTo:redirect});
      else result=await api.auth.signInWithPassword({email,password});
      if(result.error)throw result.error;
      if(mode==='signup'&&!result.data.session)message('Check your email to confirm your account, then return here to sign in.');
      if(mode==='forgot')message('Check your email for a password reset link.');
      el('sync-password').value='';
    }catch(err){error(describe(err));}finally{authBusy=false;controls();}
  }
  async function start(localAdapter) {
    adapter=localAdapter;
    if(!window.supabase?.createClient || !window.TINY_SOUNDS_CLOUD){message('Private sync is unavailable. Your local board still works.');return;}
    const timeoutFetch=(input,init={})=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      const onAbort=()=>controller.abort();init.signal?.addEventListener('abort',onAbort,{once:true});
      return fetch(input,{...init,signal:controller.signal}).finally(()=>{clearTimeout(timer);init.signal?.removeEventListener('abort',onAbort);});
    };
    api=window.supabase.createClient(TINY_SOUNDS_CLOUD.url,TINY_SOUNDS_CLOUD.key,{auth:{storageKey:'tiny-sounds-auth-v1',flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},global:{fetch:timeoutFetch}});
    el('sync-login').onsubmit=e=>{e.preventDefault();authenticate('signin');};
    el('sync-sign-up').onclick=()=>authenticate('signup');el('sync-forgot').onclick=()=>authenticate('forgot');
    el('sync-google').onclick=async()=>{error('');const {error:err}=await api.auth.signInWithOAuth({provider:'google',options:{redirectTo:new URL('./',location.href).href}});if(err)error(describe(err));};
    el('sync-now').onclick=()=>cycle();el('sync-use-local').onclick=()=>cycle('local');el('sync-use-cloud').onclick=()=>cycle('cloud');
    el('sync-sign-out').onclick=async()=>{
      if(running)return;authBusy=true;controls();muted=true;generation++;clearTimeout(timer);
      const {error:err}=await api.auth.signOut({scope:'local'});
      if(err){error(describe(err));muted=false;}else{session=null;conflict=null;message('Signed out. This board remains available on this device.');}
      authBusy=false;muted=false;controls();
    };
    el('sync-recovery').onsubmit=async e=>{e.preventDefault();if(!el('sync-new-password').reportValidity())return;const {error:err}=await api.auth.updateUser({password:el('sync-new-password').value});if(err)error(describe(err));else{el('sync-new-password').value='';recovery=false;controls();schedule(0);}};
    el('sync-restore').onclick=async()=>{if(running)return;try{await adapter.restore();error('');message('Previous board restored on this device.');schedule();}catch(err){error(describe(err));}};
    api.auth.onAuthStateChange((event,next)=>{
      // Never await Auth methods inside this callback; SDK holds its session lock.
      setTimeout(()=>{
        const changed=session?.user.id!==next?.user.id;
        if(changed){generation++;conflict=null;}
        session=next;if(event==='PASSWORD_RECOVERY')recovery=true;
        controls();if(next&&!recovery){message('Checking your private account board…');schedule(0);}else if(!next)message('Sign in to carry your buttons between devices.');
      },0);
    });
    const {data,error:err}=await api.auth.getSession();if(err)error(describe(err));session=data.session;controls();
    if(session){message('Checking your private account board…');schedule(0);}
    await refreshBackup();
    new MutationObserver(()=>{if(!el('parents').hidden)schedule(0);}).observe(el('parents'),{attributes:true,attributeFilter:['hidden']});
    addEventListener('online',()=>schedule(0));addEventListener('offline',()=>{controls();if(session)message('Offline. Changes will sync when you reconnect.');});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  }
  return {start,localChanged:()=>{if(adapter){error('');if(session)message(offline()?'Saved here. Waiting for a connection.':'Saved here. Syncing your changes…');schedule();}}};
})();
