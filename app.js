const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const now = () => Date.now();
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const MODELS = [
  {id:'Llama-3.2-1B-Instruct-q4f16_1-MLC', name:'Llama 3.2 · 1B', note:'Seguro · más ligero · ~879 MB de VRAM'},
  {id:'SmolLM2-1.7B-Instruct-q4f16_1-MLC', name:'SmolLM2 · 1.7B', note:'Prueba recomendada · intermedio · ~1.77 GB de VRAM'},
  {id:'Llama-3.2-3B-Instruct-q4f16_1-MLC', name:'Llama 3.2 · 3B', note:'Muy pesado · ~2.26 GB · puede cerrar Safari en iPhone'},
  {id:'SmolLM2-360M-Instruct-q4f32_1-MLC', name:'SmolLM2 · 360M', note:'Modo emergencia · muy ligero · calidad menor'}
];

const DEFAULTS = {
  modelId: MODELS[0].id,
  autoMemory: true,
  memoryEvery: 6,
  globalLength: 'narrativa',
  globalInitiative: 'equilibrada',
  globalRomance: 'lento',
  globalThoughts: 'normales'
};

let state = {
  settings:{...DEFAULTS},
  characters:[], chats:[], messages:[], memories:[],
  currentCharacterId:null, currentChatId:null,
  engine:null, engineModel:null, generating:false, memoryPass:false,
  currentView:'Characters'
};

// ---------- IndexedDB ----------
const DB_NAME='rolemind-local-v2';
const DB_VERSION=1;
let db;
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const d=req.result;
      for(const name of ['characters','chats','messages','memories']){
        if(!d.objectStoreNames.contains(name)) d.createObjectStore(name,{keyPath:'id'});
      }
      if(!d.objectStoreNames.contains('settings')) d.createObjectStore('settings',{keyPath:'key'});
    };
    req.onsuccess=()=>{db=req.result;resolve(db)};
    req.onerror=()=>reject(req.error);
  });
}
function txStore(name,mode='readonly'){ return db.transaction(name,mode).objectStore(name); }
function idbGetAll(name){return new Promise((res,rej)=>{const r=txStore(name).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function idbPut(name,val){return new Promise((res,rej)=>{const r=txStore(name,'readwrite').put(val);r.onsuccess=()=>res(val);r.onerror=()=>rej(r.error)})}
function idbDel(name,id){return new Promise((res,rej)=>{const r=txStore(name,'readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
async function loadAll(){
  state.characters=await idbGetAll('characters');
  state.chats=await idbGetAll('chats');
  state.messages=await idbGetAll('messages');
  state.memories=await idbGetAll('memories');
  const s=await idbGetAll('settings');
  state.settings={...DEFAULTS,...Object.fromEntries(s.map(x=>[x.key,x.value]))};
  state.currentCharacterId=state.settings.lastCharacterId || state.characters[0]?.id || null;
  state.currentChatId=state.settings.lastChatId && state.chats.some(c=>c.id===state.settings.lastChatId) ? state.settings.lastChatId : null;
}
async function saveSetting(key,value){state.settings[key]=value;await idbPut('settings',{key,value})}

// ---------- Generic UI ----------
function toast(text,ms=2200){const el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),ms)}
function showModal(html){$('#sheetContent').innerHTML=html;$('#modal').classList.add('show')}
function closeModal(){ $('#modal').classList.remove('show'); }
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal()});
function formatDate(ts){try{return new Intl.DateTimeFormat('es',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(ts))}catch{return ''}}
function currentCharacter(){return state.characters.find(x=>x.id===state.currentCharacterId)||null}
function currentChat(){return state.chats.find(x=>x.id===state.currentChatId)||null}
function setView(name){
  state.currentView=name;
  $$('.view').forEach(v=>v.classList.remove('active'));
  $(`#view${name}`).classList.add('active');
  const isChat=name==='Chat';
  $('#bottomNav').style.display=isChat?'none':'grid';
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===name));
  if(name==='Characters')renderCharacters();
  if(name==='Chats')renderChats();
  if(name==='Memories')renderMemories();
  if(name==='Settings')renderSettings();
  if(name==='Chat')renderChat();
}
$$('.tab').forEach(t=>t.addEventListener('click',()=>setView(t.dataset.view)));

// ---------- Characters ----------
function renderCharacters(){
  const box=$('#charactersList');
  if(!state.characters.length){box.innerHTML=`<div class="empty"><div class="emoji">🎭</div><b>Aún no hay personajes</b><div style="margin-top:7px">Crea el primero y define exactamente cómo quieres que rolee.</div></div>`;return}
  box.innerHTML=state.characters.sort((a,b)=>b.updatedAt-a.updatedAt).map(c=>{
    const chats=state.chats.filter(x=>x.characterId===c.id).length;
    return `<div class="card character" data-character="${c.id}"><div class="avatar">${esc(c.name.slice(0,2).toUpperCase())}</div><div class="grow"><h3>${esc(c.name)}</h3><div class="muted">${esc(c.userName||'Tu personaje')} · ${chats} chat${chats===1?'':'s'}</div><div style="margin-top:6px"><span class="badge">${esc(c.narration||'1ª persona pasado')}</span></div></div><button class="iconbtn edit-character" data-id="${c.id}">⋯</button></div>`
  }).join('');
  $$('[data-character]').forEach(el=>el.addEventListener('click',async e=>{if(e.target.closest('.edit-character'))return; state.currentCharacterId=el.dataset.character;await saveSetting('lastCharacterId',state.currentCharacterId);const chats=state.chats.filter(c=>c.characterId===state.currentCharacterId).sort((a,b)=>b.updatedAt-a.updatedAt);if(chats[0]){state.currentChatId=chats[0].id;await saveSetting('lastChatId',state.currentChatId);setView('Chat')}else{openNewChatModal()}}));
  $$('.edit-character').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openCharacterModal(b.dataset.id)}));
}
$('#newCharacter').addEventListener('click',()=>openCharacterModal());
function openCharacterModal(id=null){
  const c=id?state.characters.find(x=>x.id===id):null;
  showModal(`<h2>${c?'Editar':'Nuevo'} personaje</h2>
    <label class="label">Nombre del personaje que llevará la IA</label><input id="cName" class="field" value="${esc(c?.name||'') }" placeholder="Ej. Negan">
    <label class="label">Personalidad, forma de hablar y trasfondo</label><textarea id="cPersona" class="field" placeholder="Describe con detalle cómo es, cómo habla, qué sabe, qué evita...">${esc(c?.persona||'')}</textarea>
    <label class="label">Tu personaje</label><input id="cUserName" class="field" value="${esc(c?.userName||'') }" placeholder="Ej. Oddi">
    <label class="label">Información sobre tu personaje que la IA sí puede conocer</label><textarea id="cUserDesc" class="field" placeholder="Aspecto, historia conocida, forma de ser...">${esc(c?.userDescription||'')}</textarea>
    <label class="label">Narración</label><select id="cNarration" class="field"><option>1ª persona pasado</option><option>1ª persona presente</option><option>3ª persona pasado</option><option>3ª persona presente</option></select>
    <label class="label">Instrucciones extra</label><textarea id="cExtra" class="field" placeholder="Ej. Observa microgestos, sarcasmo, presión psicológica; no acelerar el romance...">${esc(c?.extra||'')}</textarea>
    <div class="row" style="margin-top:14px"><button id="saveCharacterModal" class="btn primary grow">Guardar</button>${c?'<button id="deleteCharacterModal" class="btn danger">Eliminar</button>':''}</div>`);
  $('#cNarration').value=c?.narration||'1ª persona pasado';
  $('#saveCharacterModal').onclick=async()=>{
    const name=$('#cName').value.trim();if(!name){toast('Ponle un nombre');return}
    const obj={id:c?.id||uid(),name,persona:$('#cPersona').value.trim(),userName:$('#cUserName').value.trim()||'Tu personaje',userDescription:$('#cUserDesc').value.trim(),narration:$('#cNarration').value,extra:$('#cExtra').value.trim(),createdAt:c?.createdAt||now(),updatedAt:now()};
    await idbPut('characters',obj); state.characters=state.characters.filter(x=>x.id!==obj.id).concat(obj);state.currentCharacterId=obj.id;await saveSetting('lastCharacterId',obj.id);closeModal();renderCharacters();toast('Personaje guardado');
  };
  if(c) $('#deleteCharacterModal').onclick=async()=>{if(!confirm('¿Eliminar este personaje y todos sus chats, mensajes y recuerdos?'))return;const chatIds=state.chats.filter(x=>x.characterId===c.id).map(x=>x.id);for(const m of state.messages.filter(x=>chatIds.includes(x.chatId)))await idbDel('messages',m.id);for(const m of state.memories.filter(x=>x.characterId===c.id))await idbDel('memories',m.id);for(const ch of state.chats.filter(x=>x.characterId===c.id))await idbDel('chats',ch.id);await idbDel('characters',c.id);await loadAll();closeModal();renderCharacters()};
}

// ---------- Chats ----------
function renderChats(){
  const char=currentCharacter();
  $('#chatsContext').textContent=char?`Personaje: ${char.name}`:'Elige o crea un personaje primero.';
  const list=char?state.chats.filter(c=>c.characterId===char.id).sort((a,b)=>b.updatedAt-a.updatedAt):[];
  $('#chatsList').innerHTML=list.length?list.map(c=>`<div class="card" data-chat="${c.id}"><div class="row between"><div><div class="sub">${esc(c.title)}</div><div class="muted" style="margin-top:4px">${esc(c.location||'Sin lugar')} · ${state.messages.filter(m=>m.chatId===c.id).length} mensajes</div></div><button class="iconbtn edit-chat" data-id="${c.id}">⋯</button></div></div>`).join(''):`<div class="empty"><div class="emoji">💬</div>No hay conversaciones para este personaje.</div>`;
  $$('[data-chat]').forEach(el=>el.addEventListener('click',async e=>{if(e.target.closest('.edit-chat'))return;state.currentChatId=el.dataset.chat;await saveSetting('lastChatId',state.currentChatId);setView('Chat')}));
  $$('.edit-chat').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openEditChatModal(b.dataset.id)}));
}
$('#newChat').addEventListener('click',openNewChatModal);
function openNewChatModal(){
  if(!currentCharacter()){toast('Primero crea o elige un personaje');setView('Characters');return}
  showModal(`<h2>Nueva conversación</h2><label class="label">Título</label><input id="nTitle" class="field" placeholder="Ej. Primer día en el Santuario"><label class="label">Lugar</label><input id="nLocation" class="field" placeholder="Ej. Oficina"><label class="label">Momento</label><input id="nMoment" class="field" placeholder="Ej. Tarde"><label class="label">Quiénes están presentes</label><input id="nPresent" class="field" placeholder="Ej. Negan, Oddi y Simon"><label class="label">Hilos abiertos</label><textarea id="nThreads" class="field" placeholder="Una línea por asunto pendiente"></textarea><button id="createChatModal" class="btn primary" style="width:100%;margin-top:14px">Crear y abrir</button>`);
  $('#createChatModal').onclick=async()=>{const ch={id:uid(),characterId:state.currentCharacterId,title:$('#nTitle').value.trim()||'Nueva conversación',location:$('#nLocation').value.trim(),moment:$('#nMoment').value.trim(),present:$('#nPresent').value.trim(),threads:$('#nThreads').value.trim(),summary:'',userTurns:0,createdAt:now(),updatedAt:now()};await idbPut('chats',ch);state.chats.push(ch);state.currentChatId=ch.id;await saveSetting('lastChatId',ch.id);closeModal();setView('Chat')};
}
function openEditChatModal(id){
  const ch=state.chats.find(x=>x.id===id);if(!ch)return;
  showModal(`<h2>Escena y conversación</h2><label class="label">Título</label><input id="eTitle" class="field" value="${esc(ch.title)}"><label class="label">Lugar</label><input id="eLocation" class="field" value="${esc(ch.location||'')}"><label class="label">Momento</label><input id="eMoment" class="field" value="${esc(ch.moment||'')}"><label class="label">Presentes</label><input id="ePresent" class="field" value="${esc(ch.present||'')}"><label class="label">Hilos abiertos</label><textarea id="eThreads" class="field">${esc(ch.threads||'')}</textarea><div class="row" style="margin-top:14px"><button id="saveChatModal" class="btn primary grow">Guardar</button><button id="deleteChatModal" class="btn danger">Eliminar</button></div>`);
  $('#saveChatModal').onclick=async()=>{Object.assign(ch,{title:$('#eTitle').value.trim()||ch.title,location:$('#eLocation').value.trim(),moment:$('#eMoment').value.trim(),present:$('#ePresent').value.trim(),threads:$('#eThreads').value.trim(),updatedAt:now()});await idbPut('chats',ch);closeModal();renderChats();if(state.currentChatId===ch.id)renderChat()};
  $('#deleteChatModal').onclick=async()=>{if(!confirm('¿Eliminar esta conversación y sus mensajes?'))return;for(const m of state.messages.filter(x=>x.chatId===ch.id))await idbDel('messages',m.id);for(const m of state.memories.filter(x=>x.chatId===ch.id))await idbDel('memories',m.id);await idbDel('chats',ch.id);await loadAll();closeModal();renderChats()};
}

// ---------- Memories ----------
function renderMemories(){
  const char=currentCharacter(), ch=currentChat();
  $('#memoryContext').textContent=char?`${char.name}${ch?` · ${ch.title}`:''}`:'Elige un personaje.';
  $('#chatSummary').value=ch?.summary||'';
  const list=char?state.memories.filter(m=>m.characterId===char.id && (!m.chatId || m.chatId===ch?.id)).sort((a,b)=>(b.pinned-a.pinned)||(b.importance-a.importance)||(b.createdAt-a.createdAt)):[];
  $('#memoriesList').innerHTML=list.length?list.map(m=>`<div class="memory"><div class="row between"><div class="stars">${'★'.repeat(m.importance)}${'☆'.repeat(5-m.importance)} ${m.pinned?'<span class="pin">📌</span>':''}</div><button class="msgact edit-memory" data-id="${m.id}">Editar</button></div><div style="margin:7px 0;line-height:1.4">${esc(m.content)}</div><div class="tiny">${m.chatId?'Solo este chat':'Todas las conversaciones'}${m.tags?` · ${esc(m.tags)}`:''}</div></div>`).join(''):`<div class="empty"><div class="emoji">🧠</div>Aún no hay recuerdos guardados.</div>`;
  $$('.edit-memory').forEach(b=>b.onclick=()=>openMemoryModal(b.dataset.id));
}
$('#newMemory').addEventListener('click',()=>openMemoryModal());
function openMemoryModal(id=null,prefill=''){
  const m=id?state.memories.find(x=>x.id===id):null;if(!currentCharacter()){toast('Elige un personaje');return}
  showModal(`<h2>${m?'Editar':'Nuevo'} recuerdo</h2><label class="label">Recuerdo</label><textarea id="mContent" class="field">${esc(m?.content||prefill)}</textarea><label class="label">Importancia</label><select id="mImportance" class="field">${[1,2,3,4,5].map(n=>`<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5-n)}</option>`).join('')}</select><label class="label">Etiquetas (opcional)</label><input id="mTags" class="field" value="${esc(m?.tags||'') }" placeholder="Simon, confianza, discusión"><label class="label">Alcance</label><select id="mScope" class="field"><option value="chat">Solo esta conversación</option><option value="character">Todas las conversaciones del personaje</option></select><div class="row between" style="margin-top:12px"><span>📌 Fijar siempre</span><button id="mPin" class="switch ${m?.pinned?'on':''}"></button></div><div class="row" style="margin-top:14px"><button id="saveMemoryModal" class="btn primary grow">Guardar</button>${m?'<button id="deleteMemoryModal" class="btn danger">Eliminar</button>':''}</div>`);
  $('#mImportance').value=String(m?.importance||3);$('#mScope').value=m?.chatId?'chat':'character';let pinned=!!m?.pinned;$('#mPin').onclick=()=>{pinned=!pinned;$('#mPin').classList.toggle('on',pinned)};
  $('#saveMemoryModal').onclick=async()=>{const content=$('#mContent').value.trim();if(!content){toast('Escribe el recuerdo');return}const obj={id:m?.id||uid(),characterId:state.currentCharacterId,chatId:$('#mScope').value==='chat'?state.currentChatId:null,content,importance:Number($('#mImportance').value),pinned,tags:$('#mTags').value.trim(),source:m?.source||'manual',createdAt:m?.createdAt||now(),updatedAt:now()};await idbPut('memories',obj);state.memories=state.memories.filter(x=>x.id!==obj.id).concat(obj);closeModal();renderMemories();toast('Recuerdo guardado')};
  if(m)$('#deleteMemoryModal').onclick=async()=>{await idbDel('memories',m.id);state.memories=state.memories.filter(x=>x.id!==m.id);closeModal();renderMemories()};
}
$('#saveSummary').onclick=async()=>{const ch=currentChat();if(!ch)return;ch.summary=$('#chatSummary').value.trim();ch.updatedAt=now();await idbPut('chats',ch);toast('Resumen guardado')};
$('#forceMemoryPass').onclick=async()=>{if(!currentChat())return;try{await ensureEngine();await runMemoryMaintenance(true);renderMemories()}catch(e){showError(e)}};

// ---------- Settings / model ----------
function renderSettings(){
  $('#memoryEvery').value=String(state.settings.memoryEvery);$('#globalLength').value=state.settings.globalLength;$('#globalInitiative').value=state.settings.globalInitiative;$('#globalRomance').value=state.settings.globalRomance;$('#globalThoughts').value=state.settings.globalThoughts;$('#autoMemorySwitch').classList.toggle('on',!!state.settings.autoMemory);
  $('#gpuInfo').innerHTML=`WebGPU: ${navigator.gpu?'<span class="ok">disponible</span>':'<span class="dangertext">no detectado</span>'} · Modelo elegido: ${esc(MODELS.find(m=>m.id===state.settings.modelId)?.name||state.settings.modelId)}`;
}
$('#autoMemorySwitch').onclick=async()=>{await saveSetting('autoMemory',!state.settings.autoMemory);renderSettings()};
$('#saveSettings').onclick=async()=>{for(const [k,id] of [['memoryEvery','#memoryEvery'],['globalLength','#globalLength'],['globalInitiative','#globalInitiative'],['globalRomance','#globalRomance'],['globalThoughts','#globalThoughts']])await saveSetting(k,k==='memoryEvery'?Number($(id).value):$(id).value);toast('Ajustes guardados')};
function openModelModal(){
  showModal(`<h2>Modelo de IA</h2><div class="muted">En iPhone empieza por 1B. Si funciona, prueba SmolLM2 1.7B. El 3B puede superar la memoria disponible.</div>${MODELS.map(m=>`<div class="model-option ${m.id===state.settings.modelId?'selected':''}" data-model="${m.id}"><strong>${esc(m.name)}</strong><span class="muted">${esc(m.note)}</span></div>`).join('')}<div class="warning muted" style="margin-top:12px">Cambiar de modelo no borra tus chats. El nuevo modelo tendrá que descargarse la primera vez.</div>`);
  $$('.model-option').forEach(x=>x.onclick=async()=>{await saveSetting('modelId',x.dataset.model);state.engine=null;state.engineModel=null;closeModal();updateModelPill();renderSettings();toast('Modelo cambiado')});
}
$('#chooseModel').onclick=openModelModal;$('#modelPill').onclick=openModelModal;
$('#loadModel').onclick=async()=>{
  const btn=$('#loadModel');
  if(btn.disabled)return;
  const original=btn.textContent;
  btn.disabled=true;
  btn.textContent='Preparando IA…';
  toast('Iniciando IA local…');
  try{
    await ensureEngine();
    toast('IA lista');
  }catch(e){
    setProgress(false);
    showError(e);
  }finally{
    btn.disabled=false;
    btn.textContent=original;
  }
};
function updateModelPill(){const m=MODELS.find(x=>x.id===state.settings.modelId);$('#modelPill').textContent=state.engine?`IA: ${m?.name||'lista'}`:`IA: ${m?.name||'sin cargar'}`}
function setProgress(show,text='',pct=0){$('#progressWrap').classList.toggle('show',show);$('#progressText').textContent=text;$('#progressBar').style.width=`${Math.max(0,Math.min(100,pct))}%`}
async function ensureEngine(){
  if(state.engine && state.engineModel===state.settings.modelId)return state.engine;
  if(!navigator.gpu)throw new Error('WebGPU no está disponible en esta instalación. Abre RoleMind con iOS 26/Safari 26 o posterior y vuelve a probar.');

  setProgress(true,'1/3 · Cargando WebLLM…',2);
  let webllm;
  try{
    webllm=await import('https://esm.run/@mlc-ai/web-llm@0.2.84');
  }catch(importErr){
    throw new Error('No he podido cargar la librería WebLLM desde Internet. Comprueba la conexión Wi‑Fi y vuelve a intentarlo. Detalle: '+(importErr?.message||importErr));
  }

  setProgress(true,'2/3 · Preparando el motor local…',4);
  const progressCb=(p)=>{
    const raw=Number(p?.progress||0);
    const pct=Number.isFinite(raw)?Math.max(5,raw*100):5;
    setProgress(true,p?.text||'3/3 · Descargando el modelo al iPhone…',pct);
  };

  let worker=null;
  try{
    worker=new Worker(new URL('./ai-worker.js?v=2.2',import.meta.url),{type:'module'});
    state.engine=await webllm.CreateWebWorkerMLCEngine(worker,state.settings.modelId,{initProgressCallback:progressCb});
  }catch(workerErr){
    console.warn('Web Worker no disponible; probando motor directo',workerErr);
    try{worker?.terminate()}catch{}
    setProgress(true,'Modo compatible · preparando IA directamente…',5);
    state.engine=await webllm.CreateMLCEngine(state.settings.modelId,{initProgressCallback:progressCb});
  }

  state.engineModel=state.settings.modelId;
  setProgress(false);
  updateModelPill();
  return state.engine;
}

// ---------- Chat ----------
function chatMessages(){return state.messages.filter(m=>m.chatId===state.currentChatId).sort((a,b)=>a.createdAt-b.createdAt)}
function renderChat(){
  const ch=currentChat(), char=currentCharacter();if(!ch||!char){setView('Chats');return}
  $('#chatTitle').textContent=ch.title;$('#chatSubtitle').textContent=`${char.name}${ch.location?' · '+ch.location:''}`;
  const msgs=chatMessages();$('#messages').innerHTML=msgs.length?msgs.map(m=>`<div class="bubble ${m.role}" data-msg="${m.id}">${esc(m.content)}</div><div class="meta-actions ${m.role}">${m.role==='assistant'?`<button class="msgact regenerate" data-id="${m.id}">↻ Regenerar</button>`:''}<button class="msgact remember-msg" data-id="${m.id}">🧠 Recordar</button></div>`).join(''):`<div class="empty"><div class="emoji">✍️</div>Empieza la escena. La IA no escribirá las acciones ni el diálogo de tu personaje.</div>`;
  requestAnimationFrame(()=>{$('#messages').scrollTop=$('#messages').scrollHeight});
  $$('.remember-msg').forEach(b=>b.onclick=()=>{const m=state.messages.find(x=>x.id===b.dataset.id);openMemoryModal(null,m?.content||'')});
  $$('.regenerate').forEach(b=>b.onclick=()=>regenerateFrom(b.dataset.id));
}
$('#backFromChat').onclick=()=>setView('Chats');$('#chatOptions').onclick=()=>openEditChatModal(state.currentChatId);
$('#sendMessage').onclick=sendCurrentMessage;
$('#messageInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendCurrentMessage()}});

async function sendCurrentMessage(){
  if(state.generating)return;const input=$('#messageInput');const text=input.value.trim();if(!text)return;
  if(text.toUpperCase()==='REP'){input.value='';await regenerateLast();return}
  const ch=currentChat();if(!ch)return;
  const msg={id:uid(),chatId:ch.id,role:'user',content:text,createdAt:now()};await idbPut('messages',msg);state.messages.push(msg);ch.userTurns=(ch.userTurns||0)+1;ch.updatedAt=now();await idbPut('chats',ch);input.value='';renderChat();await generateAssistant();
}

async function generateAssistant(extraInstruction=''){
  if(state.generating)return;state.generating=true;$('#sendMessage').disabled=true;
  let placeholder=null;
  try{
    const engine=await ensureEngine();const payload=buildPrompt(extraInstruction);
    placeholder={id:uid(),chatId:state.currentChatId,role:'assistant',content:'',createdAt:now()};state.messages.push(placeholder);renderChat();
    const chunks=await engine.chat.completions.create({messages:payload,temperature:.86,top_p:.93,max_tokens:maxTokens(),stream:true});
    let text='';for await(const chunk of chunks){text+=chunk.choices?.[0]?.delta?.content||'';placeholder.content=text;const el=document.querySelector(`[data-msg="${placeholder.id}"]`);if(el){el.textContent=text;$('#messages').scrollTop=$('#messages').scrollHeight}}
    placeholder.content=text.trim()||'(La IA no devolvió texto.)';await idbPut('messages',placeholder);const ch=currentChat();ch.updatedAt=now();await idbPut('chats',ch);renderChat();
    if(state.settings.autoMemory && (ch.userTurns||0)%Number(state.settings.memoryEvery||6)===0){await runMemoryMaintenance(false)}
  }catch(e){if(placeholder){state.messages=state.messages.filter(x=>x.id!==placeholder.id)}showError(e);renderChat()}
  finally{state.generating=false;$('#sendMessage').disabled=false;setProgress(false)}
}
function maxTokens(){return ({breve:300,media:500,narrativa:750,larga:950})[state.settings.globalLength]||700}

async function regenerateLast(){const list=chatMessages();const last=[...list].reverse().find(m=>m.role==='assistant');if(!last){toast('No hay respuesta que repetir');return}await regenerateFrom(last.id)}
async function regenerateFrom(id){
  if(state.generating)return;const list=chatMessages();const idx=list.findIndex(m=>m.id===id);if(idx<0)return;const target=list[idx];if(target.role!=='assistant')return;
  // Remove target and every later assistant message only if target is the last assistant; preserve user messages after it would be confusing, so restrict.
  const lastAssistant=[...list].reverse().find(m=>m.role==='assistant');if(lastAssistant?.id!==id){toast('Solo se puede regenerar la última respuesta de la IA');return}
  await idbDel('messages',id);state.messages=state.messages.filter(m=>m.id!==id);renderChat();await generateAssistant('Reformula tu respuesta anterior de manera claramente distinta. Conserva los hechos y la continuidad, pero cambia redacción, ritmo y enfoque.');
}

// ---------- Prompt + memory retrieval ----------
const STOP=new Set('de la el los las un una unos unas y o que en a al del por para con sin sobre se es son era eran fue fueron ser estar como más menos muy ya si sí no su sus mi mis tu tus este esta estos estas eso esa ese e ha han hay lo le les me te nos pero porque cuando donde qué quien quién desde hasta entre tras'.split(' '));
function norm(s=''){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9áéíóúüñ]+/gi,' ').trim()}
function tokens(s=''){return norm(s).split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)).slice(0,120)}
function jaccard(a,b){const A=new Set(a),B=new Set(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return n/(A.size+B.size-n)}
function relevantMemories(query){
  const ch=currentChat(),char=currentCharacter();if(!ch||!char)return[];const qt=tokens(query);const candidates=state.memories.filter(m=>m.characterId===char.id && (!m.chatId||m.chatId===ch.id));
  return candidates.map(m=>{const mt=tokens(`${m.content} ${m.tags||''}`);const overlap=jaccard(qt,mt);const proper=[...new Set(tokens(m.tags||''))].filter(t=>qt.includes(t)).length;const ageDays=(now()-m.createdAt)/86400000;const recency=Math.max(0,1-ageDays/120);const score=(m.pinned?6:0)+(m.importance||3)*.65+overlap*8+proper*1.2+recency*.35;return{m,score}}).sort((a,b)=>b.score-a.score).slice(0,7).map(x=>x.m);
}
function buildPrompt(extraInstruction=''){
  const char=currentCharacter(),ch=currentChat(),all=chatMessages();
  const recentText=all.slice(-5).map(m=>m.content).join('\n');const mems=relevantMemories(recentText);
  const system=`Eres ${char.name} en un roleplay narrativo con el usuario, que controla exclusivamente a ${char.userName||'su personaje'}.

REGLAS INNEGOCIABLES DEL ROL
- Nunca escribas acciones, pensamientos, emociones internas, decisiones ni diálogo de ${char.userName||'el personaje del usuario'}. Deja siempre espacio real para que el usuario decida qué hace.
- Tú controlas a ${char.name} y a NPC secundarios cuando sea necesario.
- Mantén continuidad estricta. No inventes que alguien entra, sale, sabe algo o tiene un objeto si contradice el contexto.
- No resumas la escena: interprétala.
- Evita pedir permiso constantemente. Con iniciativa ${state.settings.globalInitiative}, haz avanzar la escena de forma natural dentro de la personalidad del personaje.
- Romance: ${state.settings.globalRomance}. Pensamientos internos: ${state.settings.globalThoughts}. Longitud: ${state.settings.globalLength}.
- Narración preferida: ${char.narration||'1ª persona pasado'}.
${extraInstruction?`- INSTRUCCIÓN PARA ESTA RESPUESTA: ${extraInstruction}\n`:''}

PERSONAJE DE LA IA
${(char.persona||'Sin descripción adicional.').slice(0,2200)}
${char.extra?`\nINSTRUCCIONES DE ESTILO\n${char.extra.slice(0,1200)}`:''}

PERSONAJE DEL USUARIO (solo información; NO lo controles)
Nombre: ${char.userName||'Usuario'}
${(char.userDescription||'').slice(0,700)}

ESCENA ACTUAL
Lugar: ${ch.location||'no especificado'}
Momento: ${ch.moment||'no especificado'}
Presentes: ${ch.present||'no especificado'}
Hilos abiertos: ${(ch.threads||'ninguno especificado').slice(0,700)}

RESUMEN DE CONTINUIDAD
${(ch.summary||'Todavía no existe resumen.').slice(0,1500)}

RECUERDOS RELEVANTES
${mems.length?mems.map(m=>`- [${m.importance}/5${m.pinned?', FIJO':''}] ${m.content.slice(0,350)}`).join('\n'):'- Ninguno recuperado.'}`;
  // Keep recent chat within a conservative character budget for 4k-context mobile models.
  const hist=[];let budget=5600;for(const m of [...all].reverse()){if(m.content.length>budget&&hist.length>=4)break;const content=m.content.slice(-Math.min(1500,budget));hist.push({role:m.role,content});budget-=content.length;if(budget<=0)break}hist.reverse();
  return [{role:'system',content:system},...hist];
}

// ---------- Automatic memory maintenance ----------
async function runMemoryMaintenance(force=false){
  if(state.memoryPass || (state.generating && force))return;const ch=currentChat(),char=currentCharacter();if(!ch||!char)return;const msgs=chatMessages();if(msgs.length<4&&!force){return}
  state.memoryPass=true;setProgress(true,'🧠 Ordenando recuerdos y continuidad…',82);
  try{
    const engine=await ensureEngine();const transcript=msgs.slice(-12).map(m=>`${m.role==='user'?char.userName:char.name}: ${m.content.slice(0,900)}`).join('\n');
    const prompt=[{role:'system',content:`Actúas como gestor de memoria de un roleplay. Devuelve SOLO JSON válido, sin Markdown. No inventes hechos. Conserva cambios de relación, promesas, conflictos, revelaciones, preferencias, heridas, objetos importantes y acontecimientos que puedan importar en escenas futuras. Omite acciones triviales. El resumen debe actualizar la continuidad sin borrar hechos relevantes previos. Formato exacto: {"summary":"...","memories":[{"content":"...","importance":1,"tags":"..."}]}. importance va de 1 a 5. Máximo 3 recuerdos nuevos.`},{role:'user',content:`RESUMEN ANTERIOR:\n${(ch.summary||'(vacío)').slice(0,1700)}\n\nÚLTIMA PARTE DEL ROL:\n${transcript}\n\nDevuelve el JSON.`}];
    const out=await engine.chat.completions.create({messages:prompt,temperature:.15,top_p:.8,max_tokens:420});const raw=out.choices?.[0]?.message?.content||'';const data=parseJSONLoose(raw);
    if(data?.summary){ch.summary=String(data.summary).slice(0,2600);ch.updatedAt=now();await idbPut('chats',ch)}
    if(Array.isArray(data?.memories))for(const item of data.memories.slice(0,3)){const content=String(item.content||'').trim();if(content.length<8||isDuplicateMemory(content))continue;const m={id:uid(),characterId:char.id,chatId:ch.id,content:content.slice(0,650),importance:Math.max(1,Math.min(5,Number(item.importance)||3)),pinned:false,tags:String(item.tags||'').slice(0,160),source:'auto',createdAt:now(),updatedAt:now()};await idbPut('memories',m);state.memories.push(m)}
    if(force)toast('Memoria actualizada');
  }catch(e){console.warn('Memory pass failed',e);if(force)showError(e)}finally{state.memoryPass=false;setProgress(false)}
}
function parseJSONLoose(raw){let s=raw.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)s=s.slice(a,b+1);try{return JSON.parse(s)}catch{return null}}
function isDuplicateMemory(content){const nt=tokens(content);return state.memories.some(m=>jaccard(nt,tokens(m.content))>.72 || norm(m.content)===norm(content))}

// ---------- Backup ----------
$('#exportBackup').onclick=async()=>{const data={version:2,exportedAt:new Date().toISOString(),characters:state.characters,chats:state.chats,messages:state.messages,memories:state.memories,settings:state.settings};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`RoleMind-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Backup preparado')};
$('#importBackup').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!Array.isArray(data.characters)||!Array.isArray(data.chats))throw new Error('No parece un backup de RoleMind');if(!confirm('Esto añadirá/reemplazará elementos con el mismo ID. ¿Continuar?'))return;for(const name of ['characters','chats','messages','memories'])for(const x of data[name]||[])await idbPut(name,x);for(const [key,value] of Object.entries(data.settings||{}))await idbPut('settings',{key,value});await loadAll();renderAll();toast('Backup importado')}catch(err){showError(err)}finally{e.target.value=''}};

// ---------- Help ----------
$('#quickHelp').onclick=()=>showModal(`<h2>Inicio rápido</h2><div class="card"><b>1. Crea un personaje</b><div class="muted" style="margin-top:5px">Define personalidad, tu personaje y estilo.</div></div><div class="card"><b>2. Crea una conversación</b><div class="muted" style="margin-top:5px">Pon lugar, presentes e hilos abiertos.</div></div><div class="card"><b>3. Carga la IA</b><div class="muted" style="margin-top:5px">Ajustes → Descargar/cargar IA. La primera descarga es grande; usa Wi‑Fi.</div></div><div class="card"><b>4. Rolea</b><div class="muted" style="margin-top:5px">Escribe REP para repetir la última respuesta. Usa 🧠 Recordar en cualquier mensaje para fijar algo manualmente.</div></div><button class="btn primary" style="width:100%" onclick="document.getElementById('modal').classList.remove('show')">Entendido</button>`);

function showError(e){console.error(e);const msg=String(e?.message||e||'Error desconocido');showModal(`<h2>Ha ocurrido un error</h2><div class="card dangertext" style="white-space:pre-wrap">${esc(msg)}</div><div class="muted">Si es durante la carga del modelo, vuelve a Llama 1B. Si 1B funciona, prueba SmolLM2 1.7B. Evita Llama 3B si la app se cierra o vuelve al inicio.</div>`)}
function renderAll(){renderCharacters();renderChats();renderMemories();renderSettings();updateModelPill()}

// ---------- Boot ----------
(async()=>{
  try{
    await openDB();await loadAll();
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
    renderAll();setView('Characters');
  }catch(e){showError(e)}
})();
