const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const now = () => Date.now();
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const validHex=(v,fallback)=>/^#[0-9a-f]{6}$/i.test(String(v||''))?String(v):fallback;
const safeAvatar=(v='')=>/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(String(v||''))?String(v):'';
function themeFor(c){return{
  accentColor:validHex(c?.accentColor,CHARACTER_THEME_DEFAULTS.accentColor),
  userBubbleColor:validHex(c?.userBubbleColor,CHARACTER_THEME_DEFAULTS.userBubbleColor),
  assistantBubbleColor:validHex(c?.assistantBubbleColor,CHARACTER_THEME_DEFAULTS.assistantBubbleColor),
  chatBgColor:validHex(c?.chatBgColor,CHARACTER_THEME_DEFAULTS.chatBgColor)
}}
function textColorFor(hex){const h=validHex(hex,'#000000').slice(1);const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);return ((r*299+g*587+b*114)/1000)>155?'#101116':'#f7f7fb'}
function hexAlpha(hex,alpha='22'){return validHex(hex,'#8a7dff')+alpha}
function avatarMarkup(c,cls='avatar'){const a=safeAvatar(c?.avatarData);return `<div class="${cls}" style="background:${validHex(c?.accentColor,CHARACTER_THEME_DEFAULTS.accentColor)}">${a?`<img src="${a}" alt="">`:esc((c?.name||'?').slice(0,2).toUpperCase())}</div>`}
async function compressAvatar(file){
  if(!file)return'';if(!String(file.type||'').startsWith('image/'))throw new Error('El archivo elegido no es una imagen.');
  const url=URL.createObjectURL(file);try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('No he podido leer esa imagen.'));i.src=url});
    const max=512,scale=Math.min(1,max/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
    const w=Math.max(1,Math.round((img.naturalWidth||img.width)*scale)),h=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d',{alpha:false});ctx.drawImage(img,0,0,w,h);
    return canvas.toDataURL('image/jpeg',.82);
  }finally{URL.revokeObjectURL(url)}
}

const MODELS = [
  {id:'openai/gpt-oss-120b', name:'GPT-OSS · 120B', note:'RECOMENDADO · máxima calidad narrativa disponible en el plan gratuito de Groq'},
  {id:'qwen/qwen3.6-27b', name:'Qwen 3.6 · 27B', note:'Alternativa potente · buena opción si quieres comparar estilo'},
  {id:'openai/gpt-oss-20b', name:'GPT-OSS · 20B', note:'Más ligero · respaldo si alcanzas límites del modelo principal'}
];

const DEFAULTS = {
  modelId: MODELS[0].id,
  memoryModelId: 'openai/gpt-oss-20b',
  workerUrl: '',
  clientToken: '',
  autoMemory: true,
  memoryEvery: 6,
  globalLength: 'narrativa',
  globalInitiative: 'equilibrada',
  globalRomance: 'lento',
  globalThoughts: 'normales'
};

const CHARACTER_THEME_DEFAULTS={accentColor:'#8a7dff',userBubbleColor:'#332d61',assistantBubbleColor:'#171a22',chatBgColor:'#0c0d12'};

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
  if(!MODELS.some(m=>m.id===state.settings.modelId)) state.settings.modelId=DEFAULTS.modelId;
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
  document.body.classList.toggle('in-chat',isChat);
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
    const t=themeFor(c);return `<div class="card character" data-character="${c.id}" style="border-color:${hexAlpha(t.accentColor,'44')}">${avatarMarkup(c)}<div class="grow"><h3>${esc(c.name)}</h3><div class="muted">${esc(c.userName||'Tu personaje')} · ${chats} chat${chats===1?'':'s'}</div><div style="margin-top:6px"><span class="badge">${esc(c.narration||'1ª persona pasado')}</span></div></div><button class="iconbtn edit-character" data-id="${c.id}">⋯</button></div>`
  }).join('');
  $$('[data-character]').forEach(el=>el.addEventListener('click',async e=>{if(e.target.closest('.edit-character'))return; state.currentCharacterId=el.dataset.character;await saveSetting('lastCharacterId',state.currentCharacterId);const chats=state.chats.filter(c=>c.characterId===state.currentCharacterId).sort((a,b)=>b.updatedAt-a.updatedAt);if(chats[0]){state.currentChatId=chats[0].id;await saveSetting('lastChatId',state.currentChatId);setView('Chat')}else{openNewChatModal()}}));
  $$('.edit-character').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();openCharacterModal(b.dataset.id)}));
}
$('#newCharacter').addEventListener('click',()=>openCharacterModal());
function openCharacterModal(id=null){
  const c=id?state.characters.find(x=>x.id===id):null;let pendingAvatar=safeAvatar(c?.avatarData);const baseTheme=themeFor(c);let pendingTheme={...baseTheme};
  const initial=esc((c?.name||'??').slice(0,2).toUpperCase());
  showModal(`<h2>${c?'Editar':'Nuevo'} personaje</h2>
    <div class="avatar-editor"><div id="cAvatarPreview" class="avatar-preview" style="background:${pendingTheme.accentColor}">${pendingAvatar?`<img src="${pendingAvatar}" alt="">`:initial}</div><div class="grow"><div class="sub">Foto de perfil</div><div class="muted" style="margin:4px 0 8px">Se guarda solo en tu iPhone y se comprime automáticamente.</div><div class="row wrap"><label class="btn small" for="cAvatarFile">Elegir foto</label><input id="cAvatarFile" type="file" accept="image/*" hidden><button id="cAvatarRemove" class="btn small">Quitar</button></div></div></div>
    <label class="label">Nombre del personaje que llevará la IA</label><input id="cName" class="field" value="${esc(c?.name||'')}" placeholder="Ej. Negan">
    <label class="label">Personalidad, forma de hablar y trasfondo</label><textarea id="cPersona" class="field" placeholder="Describe con detalle cómo es, cómo habla, qué sabe, qué evita...">${esc(c?.persona||'')}</textarea>
    <label class="label">Tu personaje</label><input id="cUserName" class="field" value="${esc(c?.userName||'')}" placeholder="Ej. Oddi">
    <label class="label">Información sobre tu personaje que la IA sí puede conocer</label><textarea id="cUserDesc" class="field" placeholder="Aspecto, historia conocida, forma de ser...">${esc(c?.userDescription||'')}</textarea>
    <label class="label">Narración</label><select id="cNarration" class="field"><option>1ª persona pasado</option><option>1ª persona presente</option><option>3ª persona pasado</option><option>3ª persona presente</option></select>
    <label class="label">Instrucciones extra</label><textarea id="cExtra" class="field" placeholder="Ej. Observa microgestos, sarcasmo, presión psicológica; no acelerar el romance...">${esc(c?.extra||'')}</textarea>
    <div class="sub" style="margin-top:18px">🎨 Apariencia del chat</div><div class="muted" style="margin-top:4px">Cada personaje puede tener su propio tema.</div>
    <div class="preset-row"><button class="preset-dot" data-theme="purple" style="background:#8a7dff" title="Violeta"></button><button class="preset-dot" data-theme="red" style="background:#9f3441" title="Rojo oscuro"></button><button class="preset-dot" data-theme="blue" style="background:#4779d8" title="Azul"></button><button class="preset-dot" data-theme="green" style="background:#4f916f" title="Verde"></button><button class="preset-dot" data-theme="gold" style="background:#a87b38" title="Dorado"></button><button class="preset-dot" data-theme="pink" style="background:#a95889" title="Rosa"></button></div>
    <div class="theme-grid">
      <label class="color-field">Acento <input id="cAccent" type="color" value="${pendingTheme.accentColor}"></label>
      <label class="color-field">Tus mensajes <input id="cUserBubble" type="color" value="${pendingTheme.userBubbleColor}"></label>
      <label class="color-field">Mensajes IA <input id="cAssistantBubble" type="color" value="${pendingTheme.assistantBubbleColor}"></label>
      <label class="color-field">Fondo <input id="cChatBg" type="color" value="${pendingTheme.chatBgColor}"></label>
    </div>
    <div id="themePreview" class="theme-preview"><div class="preview-a">Una respuesta del personaje.</div><div class="preview-u">Tu parte del rol.</div></div>
    <button id="resetCharacterTheme" class="btn small" style="margin-top:8px">Restablecer colores</button>
    <div class="row" style="margin-top:14px"><button id="saveCharacterModal" class="btn primary grow">Guardar</button>${c?'<button id="deleteCharacterModal" class="btn danger">Eliminar</button>':''}</div>`);
  $('#cNarration').value=c?.narration||'1ª persona pasado';
  const refreshAvatar=()=>{const p=$('#cAvatarPreview');p.style.background=pendingTheme.accentColor;p.innerHTML=pendingAvatar?`<img src="${pendingAvatar}" alt="">`:esc(($('#cName').value||c?.name||'??').slice(0,2).toUpperCase())};
  const refreshTheme=()=>{pendingTheme={accentColor:validHex($('#cAccent').value,CHARACTER_THEME_DEFAULTS.accentColor),userBubbleColor:validHex($('#cUserBubble').value,CHARACTER_THEME_DEFAULTS.userBubbleColor),assistantBubbleColor:validHex($('#cAssistantBubble').value,CHARACTER_THEME_DEFAULTS.assistantBubbleColor),chatBgColor:validHex($('#cChatBg').value,CHARACTER_THEME_DEFAULTS.chatBgColor)};const p=$('#themePreview');p.style.setProperty('--preview-bg',pendingTheme.chatBgColor);p.style.setProperty('--preview-user',pendingTheme.userBubbleColor);p.style.setProperty('--preview-assistant',pendingTheme.assistantBubbleColor);p.querySelector('.preview-u').style.color=textColorFor(pendingTheme.userBubbleColor);p.querySelector('.preview-a').style.color=textColorFor(pendingTheme.assistantBubbleColor);refreshAvatar()};
  $('#cAvatarFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{toast('Preparando foto…');pendingAvatar=await compressAvatar(file);refreshAvatar();toast('Foto preparada')}catch(err){showError(err)}finally{e.target.value=''}};
  $('#cAvatarRemove').onclick=()=>{pendingAvatar='';refreshAvatar()};$('#cName').addEventListener('input',refreshAvatar);
  ['#cAccent','#cUserBubble','#cAssistantBubble','#cChatBg'].forEach(id=>$(id).addEventListener('input',refreshTheme));
  const presets={purple:{accentColor:'#8a7dff',userBubbleColor:'#332d61',assistantBubbleColor:'#171a22',chatBgColor:'#0c0d12'},red:{accentColor:'#9f3441',userBubbleColor:'#5a2930',assistantBubbleColor:'#181416',chatBgColor:'#0e0b0c'},blue:{accentColor:'#4779d8',userBubbleColor:'#29466f',assistantBubbleColor:'#151922',chatBgColor:'#0a0d13'},green:{accentColor:'#4f916f',userBubbleColor:'#2e5843',assistantBubbleColor:'#141a17',chatBgColor:'#0b0f0d'},gold:{accentColor:'#a87b38',userBubbleColor:'#614923',assistantBubbleColor:'#1b1812',chatBgColor:'#100e0a'},pink:{accentColor:'#a95889',userBubbleColor:'#633652',assistantBubbleColor:'#1c151a',chatBgColor:'#100c0f'}};
  $$('.preset-dot').forEach(b=>b.onclick=()=>{const t=presets[b.dataset.theme];if(!t)return;$('#cAccent').value=t.accentColor;$('#cUserBubble').value=t.userBubbleColor;$('#cAssistantBubble').value=t.assistantBubbleColor;$('#cChatBg').value=t.chatBgColor;refreshTheme()});
  $('#resetCharacterTheme').onclick=()=>{for(const [id,key] of [['#cAccent','accentColor'],['#cUserBubble','userBubbleColor'],['#cAssistantBubble','assistantBubbleColor'],['#cChatBg','chatBgColor']])$(id).value=CHARACTER_THEME_DEFAULTS[key];refreshTheme()};refreshTheme();
  $('#saveCharacterModal').onclick=async()=>{
    const name=$('#cName').value.trim();if(!name){toast('Ponle un nombre');return}
    const obj={...c,id:c?.id||uid(),name,persona:$('#cPersona').value.trim(),userName:$('#cUserName').value.trim()||'Tu personaje',userDescription:$('#cUserDesc').value.trim(),narration:$('#cNarration').value,extra:$('#cExtra').value.trim(),avatarData:pendingAvatar,...pendingTheme,createdAt:c?.createdAt||now(),updatedAt:now()};
    await idbPut('characters',obj);state.characters=state.characters.filter(x=>x.id!==obj.id).concat(obj);state.currentCharacterId=obj.id;await saveSetting('lastCharacterId',obj.id);closeModal();renderCharacters();if(state.currentChatId&&state.chats.some(ch=>ch.id===state.currentChatId&&ch.characterId===obj.id))renderChat();toast('Personaje guardado');
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

// ---------- Settings / IA online ----------
function cleanWorkerUrl(v=''){return String(v).trim().replace(/\/+$/,'')}
function selectedModel(){return MODELS.find(m=>m.id===state.settings.modelId)||MODELS[0]}
function renderSettings(){
  $('#memoryEvery').value=String(state.settings.memoryEvery);
  $('#globalLength').value=state.settings.globalLength;$('#globalInitiative').value=state.settings.globalInitiative;$('#globalRomance').value=state.settings.globalRomance;$('#globalThoughts').value=state.settings.globalThoughts;
  $('#autoMemorySwitch').classList.toggle('on',!!state.settings.autoMemory);
  if($('#workerUrl')) $('#workerUrl').value=state.settings.workerUrl||'';
  if($('#clientToken')) $('#clientToken').value=state.settings.clientToken||'';
  $('#gpuInfo').innerHTML=`Modelo narrativo: <b>${esc(selectedModel().name)}</b><br>Memoria: <b>GPT-OSS · 20B</b> · ${state.engine?'<span class="ok">puente conectado</span>':'<span class="muted">conexión no comprobada</span>'}`;
}
$('#autoMemorySwitch').onclick=async()=>{await saveSetting('autoMemory',!state.settings.autoMemory);renderSettings()};
$('#saveSettings').onclick=async()=>{
  for(const [k,id] of [['memoryEvery','#memoryEvery'],['globalLength','#globalLength'],['globalInitiative','#globalInitiative'],['globalRomance','#globalRomance'],['globalThoughts','#globalThoughts']]) await saveSetting(k,k==='memoryEvery'?Number($(id).value):$(id).value);
  if($('#workerUrl')) await saveSetting('workerUrl',cleanWorkerUrl($('#workerUrl').value));
  if($('#clientToken')) await saveSetting('clientToken',$('#clientToken').value.trim());
  state.engine=null;state.engineModel=null;updateModelPill();renderSettings();toast('Ajustes guardados');
};
$('#generateClientToken')?.addEventListener('click',async()=>{
  const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);const token=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
  $('#clientToken').value=token;await saveSetting('clientToken',token);
  try{await navigator.clipboard.writeText(token);toast('Token generado y copiado')}catch{toast('Token generado. Mantén pulsado para copiarlo')}
});
$('#copyClientToken')?.addEventListener('click',async()=>{
  const token=$('#clientToken')?.value.trim();if(!token){toast('Primero genera o escribe un token');return}
  try{await navigator.clipboard.writeText(token);toast('Token copiado')}catch{toast('Mantén pulsado el campo para copiarlo')}
});
function openModelModal(){
  showModal(`<h2>Modelo narrativo</h2><div class="muted">Estos modelos se ejecutan en GroqCloud; el iPhone ya no descarga el modelo. La memoria de RoleMind sigue guardada en tu dispositivo.</div>${MODELS.map(m=>`<div class="model-option ${m.id===state.settings.modelId?'selected':''}" data-model="${m.id}"><strong>${esc(m.name)}</strong><span class="muted">${esc(m.note)}</span></div>`).join('')}<div class="warning muted" style="margin-top:12px">Si un modelo alcanza su límite gratuito, RoleMind intentará automáticamente otro modelo permitido como respaldo.</div>`);
  $$('.model-option').forEach(x=>x.onclick=async()=>{await saveSetting('modelId',x.dataset.model);state.engineModel=null;closeModal();updateModelPill();renderSettings();toast('Modelo cambiado')});
}
$('#chooseModel').onclick=openModelModal;$('#modelPill').onclick=openModelModal;
$('#loadModel').onclick=async()=>{
  const btn=$('#loadModel');if(btn.disabled)return;const original=btn.textContent;btn.disabled=true;btn.textContent='Comprobando…';
  if($('#workerUrl')) await saveSetting('workerUrl',cleanWorkerUrl($('#workerUrl').value));
  if($('#clientToken')) await saveSetting('clientToken',$('#clientToken').value.trim());
  try{await ensureEngine(true);toast('Conexión correcta. RoleMind está listo.')}catch(e){showError(e)}finally{btn.disabled=false;btn.textContent=original;setProgress(false);renderSettings()}
};
function updateModelPill(){const m=selectedModel();$('#modelPill').textContent=state.settings.workerUrl?`IA: ${m.name}`:'IA: configurar'}
function setProgress(show,text='',pct=0){$('#progressWrap').classList.toggle('show',show);$('#progressText').textContent=text;$('#progressBar').style.width=`${Math.max(0,Math.min(100,pct))}%`}
function apiError(message,status=0,body=null){const e=new Error(message);e.status=status;e.body=body;return e}
async function ensureEngine(force=false){
  if(state.engine&&!force)return state.engine;
  const url=cleanWorkerUrl(state.settings.workerUrl),token=String(state.settings.clientToken||'').trim();
  if(!url)throw new Error('Falta la URL del Cloudflare Worker. Ve a Ajustes y pégala en “URL del puente Cloudflare”.');
  if(!token)throw new Error('Falta el token privado de RoleMind. Ve a Ajustes y genera/pega el mismo token que guardaste como secreto en Cloudflare.');
  setProgress(true,'Conectando con el puente privado…',25);
  let res;
  try{res=await fetch(`${url}/health`,{method:'GET',headers:{'X-RoleMind-Token':token,'Accept':'application/json'},cache:'no-store'})}
  catch(err){throw new Error('No puedo conectar con el Worker. Revisa la URL y tu conexión a Internet. '+(err?.message||''))}
  let data={};try{data=await res.json()}catch{}
  if(!res.ok)throw apiError(data?.error||`El Worker respondió con error ${res.status}.`,res.status,data);
  state.engine={online:true};state.engineModel=state.settings.modelId;setProgress(false);updateModelPill();return state.engine;
}
async function callWorker({messages,model,purpose='role',max_tokens=800,temperature=.85,top_p=.95}){
  await ensureEngine();const url=cleanWorkerUrl(state.settings.workerUrl),token=String(state.settings.clientToken||'').trim();
  let res;try{res=await fetch(`${url}/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-RoleMind-Token':token,'Accept':'application/json'},body:JSON.stringify({messages,model,purpose,max_tokens,temperature,top_p})})}
  catch(err){state.engine=null;throw new Error('Se perdió la conexión con el puente de IA. '+(err?.message||''))}
  let data={};try{data=await res.json()}catch{}
  if(!res.ok){const msg=data?.error||`Error ${res.status} del servicio de IA.`;throw apiError(msg,res.status,data)}
  return data;
}
async function roleCompletion(messages){
  const chosen=state.settings.modelId;const order=[chosen,...MODELS.map(m=>m.id).filter(id=>id!==chosen)];let lastErr=null;
  for(let i=0;i<order.length;i++){
    try{
      const out=await callWorker({messages,model:order[i],purpose:'role',max_tokens:maxTokens(),temperature:.84,top_p:.94});
      if(i>0)toast(`Límite/fallo del modelo principal: usando ${MODELS.find(m=>m.id===order[i])?.name||order[i]}`,3500);
      return out;
    }catch(e){lastErr=e;if(![400,404,429,498,503].includes(Number(e.status)))throw e}
  }
  throw lastErr||new Error('No hay ningún modelo disponible ahora mismo.');
}

// ---------- Chat ----------
function chatMessages(){return state.messages.filter(m=>m.chatId===state.currentChatId).sort((a,b)=>a.createdAt-b.createdAt)}
function applyCharacterTheme(char){const t=themeFor(char),v=$('#viewChat');v.style.setProperty('--chat-accent',t.accentColor);v.style.setProperty('--chat-bg',t.chatBgColor);v.style.setProperty('--chat-glow',hexAlpha(t.accentColor,'1f'));v.style.setProperty('--user-bubble',t.userBubbleColor);v.style.setProperty('--assistant-bubble',t.assistantBubbleColor);v.style.setProperty('--user-text',textColorFor(t.userBubbleColor));v.style.setProperty('--assistant-text',textColorFor(t.assistantBubbleColor));}
function scrollChatBottom(smooth=false){const box=$('#messages');if(!box)return;requestAnimationFrame(()=>{box.scrollTo({top:box.scrollHeight,behavior:smooth?'smooth':'auto'})})}
function renderChat(){
  const ch=currentChat(),char=currentCharacter();if(!ch||!char){setView('Chats');return}applyCharacterTheme(char);
  $('#chatTitle').textContent=ch.title;$('#chatSubtitle').innerHTML=`<span class="presence-dot"></span>${esc(char.name)}${ch.location?' · '+esc(ch.location):''}`;$('#chatHeaderAvatar').outerHTML=avatarMarkup(char,'chat-avatar').replace('class="chat-avatar"','id="chatHeaderAvatar" class="chat-avatar"');
  const msgs=chatMessages();$('#messages').innerHTML=msgs.length?msgs.map(m=>{const mine=m.role==='user';const name=mine?(char.userName||'Tú'):char.name;const av=mine?'':avatarMarkup(char,'msg-avatar');return `<div class="message-row ${mine?'user-row':'assistant-row'}">${av}<div class="msg-stack"><div class="msg-name">${esc(name)}</div><div class="bubble ${m.role}" data-msg="${m.id}">${esc(m.content)}</div><div class="meta-actions ${m.role}">${m.role==='assistant'?`<button class="msgact regenerate" data-id="${m.id}">↻ Regenerar</button>`:''}<button class="msgact remember-msg" data-id="${m.id}">🧠 Recordar</button></div></div></div>`}).join(''):`<div class="empty"><div class="emoji">✍️</div>Empieza la escena. La IA interpretará al personaje y los NPC; tu personaje sigue siendo solo tuyo.</div>`;
  scrollChatBottom(false);
  $$('.remember-msg').forEach(b=>b.onclick=()=>{const m=state.messages.find(x=>x.id===b.dataset.id);openMemoryModal(null,m?.content||'')});
  $$('.regenerate').forEach(b=>b.onclick=()=>regenerateFrom(b.dataset.id));
}
$('#backFromChat').onclick=()=>setView('Chats');$('#chatOptions').onclick=()=>openEditChatModal(state.currentChatId);
$('#sendMessage').onclick=sendCurrentMessage;
const messageInput=$('#messageInput');
messageInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendCurrentMessage()}});
function resizeComposer(){messageInput.style.height='44px';messageInput.style.height=Math.min(118,Math.max(44,messageInput.scrollHeight))+'px'}
messageInput.addEventListener('input',resizeComposer);
messageInput.addEventListener('focus',()=>{syncVisualViewport();setTimeout(()=>scrollChatBottom(false),80);setTimeout(()=>scrollChatBottom(false),300)});
messageInput.addEventListener('blur',()=>setTimeout(syncVisualViewport,80));

async function sendCurrentMessage(){
  if(state.generating)return;const input=$('#messageInput');const text=input.value.trim();if(!text)return;
  if(text.toUpperCase()==='REP'){input.value='';await regenerateLast();return}
  const ch=currentChat();if(!ch)return;
  const msg={id:uid(),chatId:ch.id,role:'user',content:text,createdAt:now()};await idbPut('messages',msg);state.messages.push(msg);ch.userTurns=(ch.userTurns||0)+1;ch.updatedAt=now();await idbPut('chats',ch);input.value='';resizeComposer();renderChat();await generateAssistant();
}

async function generateAssistant(extraInstruction=''){
  if(state.generating)return;state.generating=true;$('#sendMessage').disabled=true;
  let placeholder=null;
  try{
    await ensureEngine();
    setProgress(true,'🧠 Recuperando recuerdos relevantes…',18);
    const payload=await buildPrompt(extraInstruction);
    placeholder={id:uid(),chatId:state.currentChatId,role:'assistant',content:'…',createdAt:now()};state.messages.push(placeholder);renderChat();
    setProgress(true,'✍️ Escribiendo la respuesta…',52);
    const out=await roleCompletion(payload);let text=String(out?.content||'').trim();
    if(text){
      setProgress(true,'🛡️ Revisando que no controle tu personaje…',78);
      text=await strictRoleGuard(text);
    }
    placeholder.content=text||'(La IA no devolvió texto.)';await idbPut('messages',placeholder);
    const ch=currentChat();ch.updatedAt=now();await idbPut('chats',ch);renderChat();
    if(state.settings.autoMemory && (ch.userTurns||0)%Number(state.settings.memoryEvery||6)===0){await runMemoryMaintenance(false)}
  }catch(e){if(placeholder){state.messages=state.messages.filter(x=>x.id!==placeholder.id)}showError(e);renderChat()}
  finally{state.generating=false;$('#sendMessage').disabled=false;setProgress(false)}
}
function maxTokens(){return ({breve:420,media:650,narrativa:950,larga:1250})[state.settings.globalLength]||900}

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
function tokens(s=''){return norm(s).split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)).slice(0,180)}
function jaccard(a,b){const A=new Set(a),B=new Set(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return n/(A.size+B.size-n)}
function candidateMemories(query,limit=20){
  const ch=currentChat(),char=currentCharacter();if(!ch||!char)return[];const qt=tokens(query);
  const candidates=state.memories.filter(m=>m.characterId===char.id && (!m.chatId||m.chatId===ch.id));
  return candidates.map(m=>{const mt=tokens(`${m.content} ${m.tags||''}`);const overlap=jaccard(qt,mt);const proper=[...new Set(tokens(m.tags||''))].filter(t=>qt.includes(t)).length;const ageDays=(now()-m.createdAt)/86400000;const recency=Math.max(0,1-ageDays/180);const score=(m.pinned?12:0)+(m.importance||3)*1.1+overlap*12+proper*1.8+recency*.35;return{m,score}}).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.m);
}
async function relevantMemories(query){
  const candidates=candidateMemories(query,20);if(candidates.length<=8)return candidates;
  const pinned=candidates.filter(m=>m.pinned);const compact=candidates.map((m,i)=>`M${i} | imp:${m.importance||3}${m.pinned?' | FIJO':''} | tags:${m.tags||'-'} | ${m.content.slice(0,330)}`).join('\n');
  const prompt=[{role:'system',content:'Eres un recuperador de memoria para roleplay. Elige recuerdos que ayuden a responder al turno actual: mismos personajes, relaciones, promesas, conflictos, secretos, lugares, objetos, antecedentes o paralelismos relevantes. Prioriza FIJO y alta importancia. Devuelve SOLO JSON válido: {"ids":["M0","M3"]}. Máximo 8 ids. No expliques nada.'},{role:'user',content:`TURNO/CONTEXTO RECIENTE:\n${query.slice(0,2400)}\n\nRECUERDOS CANDIDATOS:\n${compact}`}];
  try{
    const out=await callWorker({messages:prompt,model:state.settings.memoryModelId,purpose:'rerank',max_tokens:220,temperature:.05,top_p:.8});const data=parseJSONLoose(out?.content||'');
    const chosen=(data?.ids||[]).map(x=>String(x).match(/^M(\d+)$/)?.[1]).filter(x=>x!==undefined).map(i=>candidates[Number(i)]).filter(Boolean);
    const result=[...pinned,...chosen].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i).slice(0,8);return result.length?result:candidates.slice(0,8);
  }catch(e){console.warn('Memory rerank failed; using local retrieval',e);return candidates.slice(0,8)}
}
async function buildPrompt(extraInstruction=''){
  const char=currentCharacter(),ch=currentChat(),all=chatMessages();
  const recentText=all.slice(-8).map(m=>`${m.role==='user'?char.userName:char.name}: ${m.content}`).join('\n');const mems=await relevantMemories(recentText);
  const system=`Eres un motor de ROLEPLAY literario. Interpretas a ${char.name}. El usuario controla EXCLUSIVAMENTE a ${char.userName||'su personaje'}.

REGLAS ABSOLUTAS
- Narra a ${char.name} en ${char.narration||'1ª persona pasado'}. Respeta esa persona y tiempo verbal durante TODA la respuesta. Si la ficha exige 1ª persona, NO uses "${char.name} hizo/dijo/miró" como voz narrativa: usa yo/me/mi.

FRONTERA DE CONTROL — PRIORIDAD MÁXIMA
- ${char.userName||'El personaje del usuario'} pertenece EXCLUSIVAMENTE al usuario. JAMÁS escribas por esa persona.
- No inventes para ${char.userName||'el personaje del usuario'} acciones, diálogo, pensamientos, emociones, intenciones, decisiones, silencios, miradas, postura, respiración, tono, expresiones, movimientos ni microgestos.
- OBSERVAR NO SIGNIFICA INVENTAR: ${char.name} solo puede tratar como real un gesto, acción o reacción de ${char.userName||'el usuario'} si aparece EXPLÍCITAMENTE en un mensaje escrito por el USUARIO o en su ficha. NUNCA uses una respuesta anterior de la IA como prueba de algo que hizo/sintió ${char.userName||'el usuario'}. Si el usuario no lo escribió, no existe todavía.
- Está prohibido fabricar algo como "sus hombros se relajaron", "tamborileó los dedos", "me sostuvo la mirada", "se quedó callada" o "aflojó la postura" salvo que el usuario ya haya escrito exactamente ese comportamiento.
- ${char.userName||'El personaje del usuario'} es una CAJA CERRADA: no conoces sus emociones o intenciones salvo que el usuario las haya declarado. ${char.name} puede especular SOLO a partir de un hecho realmente escrito por el usuario, y debe hacerlo como duda interna inequívoca. Formas válidas: "me pregunté si...", "no sabía si era X o Y", "podía significar X, aunque también Y".
- PROHIBIDO usar "como si quisiera...", "como si esperara...", "parecía querer..." o fórmulas equivalentes para asignar UN motivo concreto a ${char.userName||'el usuario'} si ese motivo no fue escrito por el usuario. Una sola interpretación disfrazada de "como si" sigue siendo una invención.
- No infieras el estado emocional por el tono si el usuario no lo describió. Ejemplo prohibido: "esa mezcla de cansancio y orgullo en su voz" si el usuario solo escribió las palabras.
- No infieras continuidad de un gesto más allá de lo escrito. Que el usuario escriba "levantó la mirada" no autoriza "mantuvo mi mirada" varios párrafos después. Que escriba "se recostó" autoriza recordar que se recostó, pero NO explicar por qué lo hizo.
- Nunca narres el efecto de ${char.name} sobre ${char.userName||'el usuario'} como hecho: prohibido "hice que se tensara", "sintió la presión", "la incomodé", "conseguí que se relajara" salvo confirmación posterior del usuario.
- Después de las acciones o palabras de ${char.name} y los NPC, DETENTE antes de narrar la respuesta de ${char.userName||'el usuario'}. Deja ese turno abierto para el usuario.
- Sí puedes interpretar a ${char.name} y a los NPC secundarios presentes.
- No repitas ni parafrasees innecesariamente el mensaje del usuario. Avanza la escena.
- Mantén continuidad física: lugar, presentes, posiciones, objetos y hechos previos.
- Los recuerdos proporcionados son hechos del rol; no los contradigas.
- No conviertas automáticamente cada escena en romance. Romance: ${state.settings.globalRomance}.
- Iniciativa: ${state.settings.globalInitiative}. Pensamientos internos: ${state.settings.globalThoughts}. Longitud: ${state.settings.globalLength}.
- Fidelidad de personaje por encima de frases ingeniosas genéricas. El humor, amenaza, ternura o sarcasmo deben salir de la personalidad descrita, no de tópicos de IA. Evita eslóganes, frases motivacionales, lenguaje de coach y ocurrencias que podrían decir personajes distintos.
- Diálogo natural y propio del personaje. Evita lenguaje genérico, explicaciones meta y preguntas de relleno.
${extraInstruction?`- INSTRUCCIÓN ESPECIAL DE ESTE TURNO: ${extraInstruction}\n`:''}

PERSONAJE IA — ${char.name}
${(char.persona||'Sin descripción adicional.').slice(0,3200)}
${char.extra?`\nDIRECTRICES DE ESTILO DEL PERSONAJE\n${char.extra.slice(0,2200)}`:''}

PERSONAJE DEL USUARIO — INFORMACIÓN, NO LO CONTROLES
${char.userName||'Usuario'}: ${(char.userDescription||'Sin descripción adicional.').slice(0,1200)}

EVIDENCIA RECIENTE CONFIRMADA POR EL USUARIO
${all.filter(m=>m.role==='user').slice(-8).map(m=>`- ${m.content.slice(0,900)}`).join('\n')||'- Ninguna.'}
IMPORTANTE: cualquier conducta de ${char.userName||'el usuario'} que aparezca SOLO en mensajes de la IA no está confirmada y no puede reutilizarse como hecho.

ESCENA ACTUAL
Lugar: ${ch.location||'no especificado'}
Momento: ${ch.moment||'no especificado'}
Presentes: ${ch.present||'no especificado'}
Hilos abiertos: ${(ch.threads||'ninguno').slice(0,1000)}

RESUMEN DE CONTINUIDAD
${(ch.summary||'Sin resumen todavía.').slice(0,2400)}

MEMORIA RECUPERADA PARA ESTE TURNO
${mems.length?mems.map(m=>`- [${m.importance||3}★${m.pinned?', FIJO':''}] ${m.content.slice(0,420)}`).join('\n'):'- Ningún recuerdo adicional.'}

Antes de mostrar la respuesta, revisa silenciosamente: (1) ¿la narración está en la persona/tiempo exigidos? (2) ¿he atribuido a ${char.userName||'el usuario'} un gesto, reacción, emoción, sensación, intención, silencio, mirada o acción que NO haya escrito EL USUARIO? (3) ¿estoy usando como evidencia algo inventado por una respuesta anterior de la IA? (4) ¿he narrado la reacción de ${char.userName||'el usuario'} a algo que acaba de hacer ${char.name}? Si 2, 3 o 4 es sí, ELIMINA esa parte o conviértela únicamente en una hipótesis interna incierta sin inventar conducta. Muestra solo el roleplay final.`;
  const hist=[];let budget=12000;for(const m of [...all].reverse()){if(budget<=0&&hist.length>=8)break;const take=Math.min(1800,Math.max(400,budget));const content=m.content.slice(-take);hist.push({role:m.role,content});budget-=content.length;if(hist.length>=14)break}hist.reverse();
  return [{role:'system',content:system},...hist];
}

// ---------- Strict user-character boundary guard ----------
function userOnlyEvidence(){
  const char=currentCharacter(),all=chatMessages();if(!char)return'';
  const userMsgs=all.filter(m=>m.role==='user').slice(-14).map((m,i)=>`U${i+1}: ${m.content.slice(0,1200)}`).join('\n');
  return `FICHA EXPLÍCITA DEL PERSONAJE DEL USUARIO:\n${(char.userDescription||'(sin ficha)').slice(0,1800)}\n\nMENSAJES ESCRITOS POR EL USUARIO (ÚNICA EVIDENCIA VÁLIDA DE SUS ACCIONES/REACCIONES):\n${userMsgs||'(ninguno)'}`;
}
async function guardCompletion(messages){
  const preferred=state.settings.modelId;
  const order=[preferred,'openai/gpt-oss-120b','qwen/qwen3.6-27b','openai/gpt-oss-20b'].filter((id,i,a)=>a.indexOf(id)===i);
  let lastErr=null;
  for(const model of order){
    try{
      return await callWorker({messages,model,purpose:'role',max_tokens:Math.min(1400,Math.max(650,maxTokens()+350)),temperature:.2,top_p:.82});
    }catch(e){lastErr=e;if(![400,404,429,498,503].includes(Number(e.status)))throw e}
  }
  throw lastErr||new Error('No hay modelo disponible para revisar la frontera del personaje del usuario.');
}
async function strictRoleGuard(candidate){
  const char=currentCharacter();if(!char||!candidate)return candidate;
  const userName=char.userName||'el personaje del usuario';
  const evidence=userOnlyEvidence();
  const lastUser=[...chatMessages()].reverse().find(m=>m.role==='user')?.content||'';
  const prompt=[
    {role:'system',content:`Eres un EDITOR FORENSE de roleplay. Tu única prioridad es proteger la agencia del personaje del usuario. No embellezcas por tu cuenta y no cambies el estilo salvo donde sea necesario.\n\nPERSONAJE DEL USUARIO: ${userName}\nPERSONAJE DE IA: ${char.name}\nVOZ EXIGIDA: ${char.narration||'1ª persona pasado'}\n\nPRINCIPIO DE PRUEBA\n${userName} es una CAJA CERRADA. Una afirmación sobre lo que hace, siente, piensa, pretende, mira, calla, expresa o cómo reacciona solo puede sobrevivir si está apoyada de forma DIRECTA por la ficha explícita o por palabras escritas por el usuario. Una respuesta anterior de la IA nunca prueba nada sobre ${userName}.\n\nAPLICA ESTA PRUEBA A CADA FRASE DE LA RESPUESTA CANDIDATA:\n1. ¿La frase afirma o presupone algo nuevo sobre ${userName}?\n2. Si sí: ¿la evidencia del usuario lo dice de forma directa?\n3. Si no está directamente respaldado: BORRA esa afirmación. No la sustituyas por otro gesto inventado.\n\nREGLAS DE LITERALIDAD\n- ACCIÓN: si el usuario escribió "se recostó", puedes mencionar que se recostó. No puedes añadir "para demostrar que...".\n- MIRADA: "levantó la mirada hacia mí" NO significa "mantuvo mis ojos", "me sostuvo la mirada" ni que siguiera mirando después.\n- DIÁLOGO: unas palabras no autorizan a inventar tono, cansancio, orgullo, miedo, ternura, nerviosismo o intención si el usuario no lo escribió.\n- SILENCIO: que el usuario todavía no haya respondido NO significa que ${userName} "guardó silencio".\n- EFECTO: una acción de ${char.name} no autoriza afirmar que ${userName} sintió presión, se intimidó, se relajó, se tensó, se sorprendió o reaccionó de ninguna manera.\n- MICROGESTOS: nunca crees respiración, dedos, hombros, labios, postura, sonrisa, ceño, ojos, manos o movimientos nuevos para ${userName}.\n- MOTIVOS: PROHIBIDO usar "como si quisiera...", "como si esperara...", "parecía querer..." o una sola explicación equivalente. Eso sigue atribuyendo una intención.\n\nESPECULACIÓN PERMITIDA\n${char.name} puede interpretar SOLO un hecho que sí esté escrito y SOLO como incertidumbre interna clara. Debe ser una duda, no una conclusión. Ejemplos válidos:\n- "Me pregunté si aquel 'Jefe' era costumbre o una forma de tantearme."\n- "No sabía si haberse recostado era simple comodidad o una pequeña provocación para Simon."\nEjemplos prohibidos:\n- "Se recostó como si quisiera demostrar que ya dominaba el trabajo."\n- "Sabía que estaba probando la paciencia de Simon."\n- "Vi en sus ojos que buscaba mi aprobación."\n\nFRONTERA TEMPORAL\nCuando ${char.name} o un NPC hable o actúe, termina sin escribir la reacción posterior de ${userName}. Deja ese espacio al usuario.\n\nVOZ\nRespeta ${char.narration||'1ª persona pasado'}. Si es primera persona, la narración de ${char.name} usa yo/me/mi; no "${char.name} hizo/dijo".\n\nEDICIÓN MÍNIMA\nConserva acciones de ${char.name}, NPC, diálogos, atmósfera, pensamientos, sarcasmo, tensión y longitud. Elimina o reformula únicamente las violaciones. No añadas hechos nuevos. No expliques tus cambios. Devuelve SOLO el roleplay final.`},
    {role:'user',content:`ÚLTIMO MENSAJE DEL USUARIO — máxima prioridad como evidencia de esta escena:\n${lastUser.slice(0,2200)||'(vacío)'}\n\nEVIDENCIA AUTORIZADA ACUMULADA SOBRE ${userName}:\n${evidence}\n\nRESPUESTA CANDIDATA:\n${candidate.slice(0,7600)}\n\nHaz la auditoría frase por frase de forma interna y devuelve únicamente la versión corregida. Si dudas de si un detalle sobre ${userName} está probado, elimínalo. No inventes una alternativa física.`}
  ];
  try{
    const out=await guardCompletion(prompt);
    const cleaned=String(out?.content||'').trim().replace(/^```(?:text|markdown)?\s*/i,'').replace(/```$/,'').trim();
    return cleaned||candidate;
  }catch(e){console.warn('Strict role guard failed; using original reply',e);return candidate}
}

// ---------- Automatic memory maintenance ----------
async function runMemoryMaintenance(force=false){
  if(state.memoryPass || (state.generating && force))return;const ch=currentChat(),char=currentCharacter();if(!ch||!char)return;const msgs=chatMessages();if(msgs.length<4&&!force)return;
  state.memoryPass=true;setProgress(true,'🧠 Consolidando memoria a largo plazo…',84);
  try{
    await ensureEngine();
    const transcript=msgs.slice(-16).map(m=>`${m.role==='user'?char.userName:char.name}: ${m.content.slice(0,1200)}`).join('\n');
    const existing=state.memories.filter(m=>m.characterId===char.id&&(!m.chatId||m.chatId===ch.id)).sort((a,b)=>(b.pinned-a.pinned)||(b.importance-a.importance)).slice(0,16).map((m,i)=>`E${i}: ${m.content.slice(0,350)} | tags:${m.tags||'-'}`).join('\n');
    const prompt=[{role:'system',content:`Eres el archivista de memoria de un roleplay largo. Devuelve SOLO JSON válido. No inventes ni deduzcas sentimientos/hechos que no estén apoyados por el texto. MUY IMPORTANTE: el personaje del usuario solo queda confirmado por lo que escribe el usuario; nunca conviertas en recuerdo una acción, emoción, gesto o reacción de ese personaje que aparezca únicamente en una respuesta de la IA, salvo que el usuario la confirme después. Tu trabajo es conservar información que pueda importar dentro de cientos de mensajes: relaciones y su evolución, conflictos, promesas, secretos, preferencias, límites, heridas, capacidades, vínculos familiares, objetos, lugares, decisiones, consecuencias y acontecimientos relevantes. Omite movimientos triviales y frases pasajeras. Evita duplicar recuerdos ya existentes.\nFormato exacto: {"summary":"resumen acumulativo","memories":[{"content":"hecho autocontenido","importance":1,"tags":"personas, tema, lugar","scope":"chat|character","category":"relationship|event|promise|conflict|preference|person|object|place|secret|other"}]}. Máximo 4 recuerdos nuevos. Usa scope=character para hechos estables o relaciones que deben recordarse en cualquier chat del personaje; scope=chat para detalles propios de esta conversación.`},{role:'user',content:`RESUMEN ANTERIOR:\n${(ch.summary||'(vacío)').slice(0,3200)}\n\nRECUERDOS YA GUARDADOS (NO LOS DUPLIQUES):\n${existing||'(ninguno)'}\n\nTRAMO RECIENTE:\n${transcript}\n\nActualiza el resumen sin borrar hechos importantes anteriores y extrae solo recuerdos nuevos realmente útiles.`}];
    const out=await callWorker({messages:prompt,model:state.settings.memoryModelId,purpose:'memory',max_tokens:700,temperature:.08,top_p:.8});const data=parseJSONLoose(out?.content||'');
    if(data?.summary){ch.summary=String(data.summary).slice(0,5200);ch.updatedAt=now();await idbPut('chats',ch)}
    if(Array.isArray(data?.memories))for(const item of data.memories.slice(0,4)){
      const content=String(item.content||'').trim();if(content.length<8||isDuplicateMemory(content))continue;
      const scope=String(item.scope||'chat').toLowerCase();const category=String(item.category||'other').toLowerCase();
      const tags=[String(item.tags||'').trim(),category].filter(Boolean).join(', ').slice(0,220);
      const m={id:uid(),characterId:char.id,chatId:scope==='character'?null:ch.id,content:content.slice(0,850),importance:Math.max(1,Math.min(5,Number(item.importance)||3)),pinned:false,tags,source:'auto-online',createdAt:now(),updatedAt:now()};await idbPut('memories',m);state.memories.push(m)
    }
    if(force)toast('Memoria a largo plazo actualizada');
  }catch(e){console.warn('Memory pass failed',e);if(force)showError(e)}finally{state.memoryPass=false;setProgress(false)}
}
function parseJSONLoose(raw){let s=raw.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)s=s.slice(a,b+1);try{return JSON.parse(s)}catch{return null}}
function isDuplicateMemory(content){const nt=tokens(content);return state.memories.some(m=>jaccard(nt,tokens(m.content))>.72 || norm(m.content)===norm(content))}

// ---------- Backup ----------
$('#exportBackup').onclick=async()=>{const safeSettings={...state.settings,clientToken:''};const data={version:2.7,exportedAt:new Date().toISOString(),characters:state.characters,chats:state.chats,messages:state.messages,memories:state.memories,settings:safeSettings};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`RoleMind-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Backup preparado')};
$('#importBackup').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!Array.isArray(data.characters)||!Array.isArray(data.chats))throw new Error('No parece un backup de RoleMind');if(!confirm('Esto añadirá/reemplazará elementos con el mismo ID. ¿Continuar?'))return;for(const name of ['characters','chats','messages','memories'])for(const x of data[name]||[])await idbPut(name,x);for(const [key,value] of Object.entries(data.settings||{}))await idbPut('settings',{key,value});await loadAll();renderAll();toast('Backup importado')}catch(err){showError(err)}finally{e.target.value=''}};

// ---------- Help ----------
$('#quickHelp').onclick=()=>showModal(`<h2>Inicio rápido</h2><div class="card"><b>1. Personaje y escena</b><div class="muted" style="margin-top:5px">Tus personajes, chats y memorias siguen guardados en el iPhone.</div></div><div class="card"><b>2. Configura el puente</b><div class="muted" style="margin-top:5px">Ajustes → pega la URL de tu Cloudflare Worker y el token privado. Pulsa Probar conexión.</div></div><div class="card"><b>3. Rolea</b><div class="muted" style="margin-top:5px">El modelo grande se ejecuta online. RoleMind recupera recuerdos relevantes antes de cada turno y consolida memoria a largo plazo automáticamente.</div></div><div class="card"><b>4. REP y memoria manual</b><div class="muted" style="margin-top:5px">Escribe REP para regenerar. Usa 🧠 Recordar para fijar cualquier dato manualmente.</div></div><button class="btn primary" style="width:100%" onclick="document.getElementById('modal').classList.remove('show')">Entendido</button>`);

function showError(e){console.error(e);let msg=String(e?.message||e||'Error desconocido');if(Number(e?.status)===429)msg+='\n\nHas alcanzado un límite gratuito temporal/diario del proveedor. RoleMind intenta modelos de respaldo automáticamente; si todos están limitados, habrá que esperar a que se reinicie la cuota.';showModal(`<h2>Ha ocurrido un error</h2><div class="card dangertext" style="white-space:pre-wrap">${esc(msg)}</div><div class="muted">Tus chats y recuerdos no se borran por un fallo de conexión. La clave de Groq permanece guardada como secreto en Cloudflare; RoleMind solo guarda en el iPhone el token privado del puente.</div>`)}
function renderAll(){renderCharacters();renderChats();renderMemories();renderSettings();updateModelPill()}

// ---------- iPhone keyboard / visual viewport ----------
let viewportRAF=0;
function syncVisualViewport(){
  cancelAnimationFrame(viewportRAF);viewportRAF=requestAnimationFrame(()=>{
    const vv=window.visualViewport;const h=Math.max(320,Math.round(vv?.height||window.innerHeight));const top=Math.max(0,Math.round(vv?.offsetTop||0));
    document.documentElement.style.setProperty('--app-height',`${h}px`);document.documentElement.style.setProperty('--app-top',`${top}px`);
    const focused=document.activeElement===messageInput;const base=Math.max(document.documentElement.clientHeight||0,window.innerHeight||0);const keyboard=focused&&vv&&(base-vv.height>90);
    document.body.classList.toggle('keyboard-open',!!keyboard);if(keyboard&&state.currentView==='Chat')setTimeout(()=>scrollChatBottom(false),40);
  });
}
window.visualViewport?.addEventListener('resize',syncVisualViewport);window.visualViewport?.addEventListener('scroll',syncVisualViewport);window.addEventListener('resize',syncVisualViewport);window.addEventListener('orientationchange',()=>setTimeout(syncVisualViewport,150));syncVisualViewport();

// ---------- Boot ----------
(async()=>{
  try{
    await openDB();await loadAll();
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
    renderAll();setView('Characters');
  }catch(e){showError(e)}
})();
