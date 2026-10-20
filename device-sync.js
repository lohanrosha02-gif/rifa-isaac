/* Sincronização privada para sites estáticos.
   Os dados continuam locais até o usuário autenticar e escolher a primeira cópia.
   Nunca cole chaves secretas/service_role nesta aplicação. */
(function(){
 "use strict";
 const cfg=window.siteCloudConfig||{};
 const app=cfg.app, keys=Array.isArray(cfg.keys)?cfg.keys:[];
 if(!app||!keys.length)return;
 const namespace="device-sync:"+app+":";
 const dbkey=namespace+"last-account";
 const el=(id)=>document.getElementById(id);
 const read=()=>({values:Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)]).filter(v=>v[1]!==null))});
 const has=(s)=>s&&s.values&&Object.keys(s.values).length>0;
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const metaKey=u=>namespace+"meta:"+u;
 const meta=u=>{try{return JSON.parse(localStorage.getItem(metaKey(u))||"null")||{version:null,dirty:false};}catch{return {version:null,dirty:false}}};
 const setMeta=(u,v)=>{try{localStorage.setItem(metaKey(u),JSON.stringify(v));}catch{}};
 let client=null,user=null,version=null,ready=false,conflict=false,writing=false,syncTimer=0,live=null;
 let lastFingerprint=JSON.stringify(read()),initializing=0;
 function status(msg,error=false){el("sync-status").textContent=msg;el("sync-status").style.color=error?"#bd5555":"#53664f";}
 function view(){
  el("sync-login").hidden=!client||!!user;
  el("sync-account").hidden=!user;
  el("sync-choice").hidden=!user||!conflict;
  el("sync-user").textContent=user?.email||"Conectado";
  el("sync-trigger").textContent=user?(ready?"☁ Sincronizado":"☁ Nuvem pendente"):"☁ Sincronizar";
 }
 function backup(data,tag){
   if(!has(data))return;
   try{localStorage.setItem(namespace+"backup:"+Date.now()+":"+tag,JSON.stringify(data));}catch{}
 }
 function apply(data){
   for(const k of keys) {
     if(typeof data?.values?.[k]==="string")localStorage.setItem(k,data.values[k]);
     else localStorage.removeItem(k);
   }
   lastFingerprint=JSON.stringify(read());
   location.reload();
 }
 function stopLive(){if(live){client?.removeChannel?.(live)?.catch?.(()=>{});live=null;}}
 function startLive(){
  if(!client?.channel||!user)return;
  stopLive();
  live=client.channel("sync-"+app+"-"+user.id)
   .on("postgres_changes",{event:"*",schema:"public",table:"personal_site_snapshots",filter:"user_id=eq."+user.id},payload=>{
      if(payload.new?.app===app||payload.old?.app===app)refresh();
    }).subscribe();
 }
 async function server(){
  const q=await client.from("personal_site_snapshots").select("payload,version")
   .eq("user_id",user.id).eq("app",app).maybeSingle();
  if(q.error)throw q.error;
  return q.data?{data:q.data.payload,version:Number(q.data.version)}:{data:null,version:0};
 }
 function readyAt(v){
   version=v;ready=true;conflict=false;
   setMeta(user.id,{version:v,dirty:false});
   lastFingerprint=JSON.stringify(read());view();
   status("Conectado. Alterações sincronizadas automaticamente.");
 }
 function choose(msg){ready=false;conflict=true;view();status(msg,true);}
 async function write(){
   if(!user||!ready||conflict||writing)return;
   const m=meta(user.id);if(!m.dirty)return;
   writing=true;status("Salvando na nuvem...");
   const snapshot=read(),fingerprint=JSON.stringify(snapshot),expected=version;
   try{
     const result=await client.rpc("personal_site_write",{
       p_app:app,p_expected_version:expected,p_payload:snapshot
     });
     if(result.error)throw result.error;
     const row=Array.isArray(result.data)?result.data[0]:result.data;
     if(!row?.written){choose("Mudanças em outro dispositivo. Escolha qual cópia manter.");return;}
     version=Number(row.server_version);
     const changed=JSON.stringify(read())!==fingerprint;
     setMeta(user.id,{version:version,dirty:changed});
     if(changed){status("Mais mudanças aguardam envio...");schedule();}
     else status("Salvo na nuvem.");
   }catch(err){
     setMeta(user.id,{version:expected,dirty:true});
     status("Falha no envio: "+String(err.message||err)+". Dados locais preservados.",true);
   }finally{writing=false;view();}
 }
 function schedule(){if(syncTimer)clearTimeout(syncTimer);syncTimer=setTimeout(()=>{syncTimer=0;write();},700);}
 function dirtyCheck(){
   const current=JSON.stringify(read());
   if(current===lastFingerprint)return;
   lastFingerprint=current;
   if(!user)return;
   const m=meta(user.id);setMeta(user.id,{version:m.version,dirty:true});
   if(ready&&!conflict)schedule();
   else if(conflict)status("Há alterações locais. Escolha qual cópia manter.",true);
 }
 async function refresh(){
   if(!user||conflict||writing||!ready)return;
   dirtyCheck();
   try{
     const s=await server(),m=meta(user.id);
     if(m.dirty){
       if(s.version===version)schedule();
       else choose("Este dispositivo e a nuvem foram alterados. Escolha qual manter.");
       return;
     }
     if(s.version!==version){
       if(s.data){
         backup(read(),"before-remote-update");
         setMeta(user.id,{version:s.version,dirty:false});
         apply(s.data);return;
       }
       choose("Dados da nuvem diferentes. Escolha como continuar.");return;
     }
     status("Todos os dados salvos.");
   }catch{status("Sem acesso à nuvem. Dados locais preservados.",true);}
 }
 async function begin(u){
  const run=++initializing;
  stopLive();user=u||null;ready=false;conflict=false;version=null;view();
  if(!user){status(client?"Entre com o mesmo e-mail em cada aparelho.":"Banco de dados não configurado.");return;}
  try{
   const previous=localStorage.getItem(dbkey);
   if(previous&&previous!==user.id){
      backup(read(),"account-change");
      // Block mixing different users' stored data.
      choose("Outra conta usou este navegador. Confirme qual cópia deseja manter.");return;
   }
   localStorage.setItem(dbkey,user.id);
   status("Consultando nuvem...");
   const s=await server();
   if(run!==initializing||!user)return;
   startLive();
   const m=meta(user.id),local=read();
   if(m.version!==null){
     version=m.version;
     if(m.dirty){if(m.version===s.version){ready=true;view();schedule();return;}
       choose("Dados alterados em dois dispositivos. Escolha a versão.");return;}
     if(m.version!==s.version){
       if(s.data){backup(local,"before-update");setMeta(user.id,{version:s.version,dirty:false});apply(s.data);return;}
       choose("A nuvem mudou. Escolha a versão.");return;
     }
     if(s.data&&!same(local,s.data)){choose("Este aparelho contém dados diferentes. Escolha a versão.");return;}
     readyAt(s.version);return;
   }
   if(s.data){
     if(has(local)&&!same(local,s.data)){choose("Há dados locais e na nuvem. Escolha qual manter.");return;}
     if(!same(local,s.data)){setMeta(user.id,{version:s.version,dirty:false});apply(s.data);return;}
     readyAt(s.version);return;
   }
   if(has(local)){choose("Primeira sincronização: escolha enviar os dados deste dispositivo.");return;}
   ready=true;version=0;setMeta(user.id,{version:0,dirty:true});view();await write();
  }catch(err){status("Nuvem inacessível: "+String(err.message||err),true);}
 }
 async function useRemote(){
   if(!user)return;
   try{
    const s=await server();
    if(!s.data){status("A nuvem ainda não tem registros. Envie os deste dispositivo.",true);return;}
    if(!confirm("Substituir os dados deste dispositivo pelos da nuvem? Uma cópia de recuperação local será guardada."))return;
    backup(read(),"before-use-remote");setMeta(user.id,{version:s.version,dirty:false});
    apply(s.data);
   }catch(err){status("Não foi possível baixar os dados: "+String(err.message||err),true);}
 }
 async function useLocal(){
   if(!user||writing)return;
   if(!confirm("Enviar os dados deste aparelho e substituir a versão na nuvem? Escolha com cuidado se outros dispositivos tiverem alterações."))return;
   try{
    const s=await server();
    backup(s.data,"before-use-local");
    version=s.version;ready=true;conflict=false;view();
    setMeta(user.id,{version:version,dirty:true});
    await write();
   }catch(err){choose("Falha ao enviar: "+String(err.message||err));}
 }
 async function login(){
   const email=el("sync-email").value.trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){status("Informe um e-mail válido.",true);return;}
   status("Enviando link de acesso...");
   try{
    const response=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});
    if(response.error)throw response.error;
    status("Abra o link enviado para seu e-mail e volte a esta página.");
   }catch(err){status("Não foi possível entrar: "+String(err.message||err),true);}
 }
 async function logout(){
   if(!user||!confirm("Sair e limpar os registros deste aparelho? Os dados sincronizados permanecem na nuvem."))return;
   const u=user;backup(read(),"before-logout");
   const r=await client.auth.signOut();if(r.error){status(r.error.message,true);return;}
   for(const k of keys)localStorage.removeItem(k);
   localStorage.removeItem(dbkey);localStorage.removeItem(metaKey(u.id));
   location.reload();
 }
 function makeUI(){
   if(el("sync-panel"))return;
   const node=document.createElement("section");
   node.id="sync-panel";
   node.style.cssText="position:fixed;bottom:12px;left:12px;z-index:9998;font:13px system-ui,Arial;max-width:min(350px,calc(100vw - 24px));color:#273626";
   node.innerHTML='<details style="background:#fff;border:1px solid #d7e8d1;border-radius:14px;box-shadow:0 8px 30px #1f30151f;padding:12px">'+
    '<summary id="sync-trigger" style="cursor:pointer;font-weight:700">☁ Sincronizar</summary>'+
    '<div style="margin-top:12px;display:grid;gap:10px">'+
    '<p id="sync-status" role="status" style="margin:0;line-height:1.55">Verificando...</p>'+
    '<div id="sync-login"><input id="sync-email" type="email" autocomplete="email" placeholder="E-mail de acesso" aria-label="E-mail" style="box-sizing:border-box;width:100%;border:1px solid #bbd3b5;padding:9px;border-radius:8px"><button id="sync-send" style="margin-top:7px;padding:9px;background:#c0f16e;border:0;border-radius:8px;width:100%;font-weight:700;cursor:pointer">Receber link de acesso</button></div>'+
    '<div id="sync-account" hidden><strong id="sync-user" style="overflow-wrap:anywhere"></strong><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button id="sync-now" style="padding:8px;background:#c0f16e;border:0;border-radius:8px;cursor:pointer">Atualizar</button><button id="sync-out" style="padding:8px;background:#edf2ea;border:0;border-radius:8px;cursor:pointer">Sair</button></div></div>'+
    '<div id="sync-choice" hidden><p style="margin:0 0 7px">Versões diferentes: escolha com cuidado.</p><button id="sync-use-cloud" style="padding:8px;margin:2px;border:1px solid #bacdad;border-radius:8px;background:white;cursor:pointer">Usar nuvem</button><button id="sync-use-device" style="padding:8px;margin:2px;border:0;border-radius:8px;background:#c0f16e;cursor:pointer">Enviar deste aparelho</button></div>'+
    '</div></details>';
   document.body.appendChild(node);
   el("sync-send").addEventListener("click",login);
   el("sync-email").addEventListener("keydown",e=>{if(e.key==="Enter")login();});
   el("sync-now").addEventListener("click",refresh);
   el("sync-out").addEventListener("click",logout);
   el("sync-use-cloud").addEventListener("click",useRemote);
   el("sync-use-device").addEventListener("click",useLocal);
 }
 async function start(){
  makeUI();
  const key=String(cfg.publishableKey||"");
  const url=String(cfg.url||"");
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)||
     !(key.startsWith("sb_publishable_")||key.startsWith("eyJ"))){
    el("sync-login").hidden=true;
    status("Nuvem preparada, mas ainda sem configuração Supabase.",true);
    return;
  }
  if(!window.supabase?.createClient){status("Cliente Supabase indisponível.",true);return;}
  client=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  view();
  client.auth.onAuthStateChange((event,session)=>{
    if(["SIGNED_IN","SIGNED_OUT","INITIAL_SESSION"].includes(event))setTimeout(()=>{
      const u=session?.user||null;
      if(!u||!user||u.id!==user.id)begin(u);
    },0);
  });
  const data=await client.auth.getUser();
  if(data.error)status(data.error.message,true);
  else await begin(data.data?.user||null);
  setInterval(()=>{dirtyCheck();if(user&&ready&&!document.hidden)refresh();},30000);
  setInterval(dirtyCheck,2500);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh();});
  window.addEventListener("online",()=>{if(user&&ready)refresh();});
 }
 if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>start().catch(console.warn),{once:true});
 else start().catch(console.warn);
})();
