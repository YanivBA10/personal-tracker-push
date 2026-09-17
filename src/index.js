import { sendPushNotification } from "@mmmike/web-push/send";

const APP_URL = "https://personal-tracker-app.pages.dev/";
const INDEX_KEY = "_meta:client-index:v1";
const MAX_LOGS = 120;
const CATCH_UP_MINUTES = 10;
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers:{...corsHeaders,"content-type":"application/json; charset=utf-8"}});
}
function validDeviceId(v){return typeof v==="string" && /^[A-Za-z0-9_-]{6,120}$/.test(v)}
function clientKey(deviceId){return `client:${deviceId}`}
function parseYmd(s){const [y,m,d]=(s||"").split("-").map(Number);return {y,m,d}}
function dayNumber(y,m,d){return Math.floor(Date.UTC(y,m-1,d)/86400000)}
function trackerDay(tr, local){const a=parseYmd(tr.startDate);if(!a.y)return 0;return dayNumber(local.year,local.month,local.day)-dayNumber(a.y,a.m,a.d)+1}
function trackerEndDay(tr){return tr.openEnded?Infinity:Number(tr.duration||1)}
function stageForDay(tr,day){if(tr.mode==="simple")return tr.stages?.[0]||null;return (tr.stages||[]).find(s=>day>=Number(s.from)&&day<=Number(s.to))||null}
function taskOccurs(t,day,stage,weekday){
  if(t.freq==="daily")return true;
  if(t.freq==="every_other")return ((day-Number(stage.from))%2===0);
  if(t.freq==="every_n")return ((day-Number(stage.from))%Math.max(1,Number(t.everyN||1))===0);
  if(t.freq==="weekdays")return (t.weekdays||[]).includes(weekday);
  return true;
}
function isDone(tr,day,id){return !!(tr.done?.[`day_${day}`]?.[id])}
function localNow(timeZone, date=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timeZone||"UTC",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,weekday:"short"}).formatToParts(date);
  const get=t=>parts.find(p=>p.type===t)?.value;const weekdays={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return {year:Number(get("year")),month:Number(get("month")),day:Number(get("day")),hour:get("hour"),minute:get("minute"),weekday:weekdays[get("weekday")]??0};
}
function localDateKey(local){return `${local.year}-${String(local.month).padStart(2,"0")}-${String(local.day).padStart(2,"0")}`}
function localHm(local){return `${local.hour}:${local.minute}`}
function hmMinutes(hm){const [h,m]=(hm||'').split(':').map(Number);return Number.isFinite(h)&&Number.isFinite(m)?h*60+m:null}
function dueWithinWindow(targetHm,local,windowMinutes=CATCH_UP_MINUTES){
  const target=hmMinutes(targetHm),now=Number(local.hour)*60+Number(local.minute);
  if(target==null||!Number.isFinite(now))return false;
  const late=now-target;return late>=0&&late<=windowMinutes;
}
function localScheduledIso(dateKey,time,timezone){return `${dateKey}T${time}:00[${timezone||"UTC"}]`}
function pushLog(data,entry){data.dispatchLog||=[];data.dispatchLog.push(entry);if(data.dispatchLog.length>MAX_LOGS)data.dispatchLog.splice(0,data.dispatchLog.length-MAX_LOGS)}
async function send(env,subscription,payload){
  if(!subscription?.endpoint)throw new Error("missing subscription");
  if(!env.VAPID_PRIVATE_KEY)throw new Error("VAPID_PRIVATE_KEY is not configured");
  return sendPushNotification(subscription,payload,{publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY,subject:env.VAPID_SUBJECT||APP_URL},{ttl:3600,urgency:"high"});
}
async function loadClient(env,deviceId){if(!env.CLIENTS)throw new Error("CLIENTS KV binding is not configured");return env.CLIENTS.get(clientKey(deviceId),"json")}
async function saveClient(env,deviceId,data){if(!env.CLIENTS)throw new Error("CLIENTS KV binding is not configured");await env.CLIENTS.put(clientKey(deviceId),JSON.stringify(data))}
async function loadIndex(env){if(!env.CLIENTS)throw new Error("CLIENTS KV binding is not configured");const v=await env.CLIENTS.get(INDEX_KEY,"json");return Array.isArray(v?.clients)?v:{version:1,clients:[]}}
async function ensureIndexed(env,deviceId){const idx=await loadIndex(env);if(idx.clients.includes(deviceId))return false;idx.clients.push(deviceId);idx.updatedAt=Date.now();await env.CLIENTS.put(INDEX_KEY,JSON.stringify(idx));return true}
function sameJson(a,b){try{return JSON.stringify(a)===JSON.stringify(b)}catch{return false}}
function sameSubscription(a,b){return sameJson(a||null,b||null)}

function reminderOccurs(r,local,dateKey){
  if(r.status!=="active"||!r.date)return false;const start=parseYmd(r.date);if(!start.y)return false;
  const todayNum=dayNumber(local.year,local.month,local.day),startNum=dayNumber(start.y,start.m,start.d);if(todayNum<startNum)return false;
  if((r.repeat||"once")==="once")return todayNum===startNum;
  if(r.repeat==="daily")return true;
  if(r.repeat==="weekly"){const wd=new Date(Date.UTC(start.y,start.m-1,start.d)).getUTCDay();return local.weekday===wd}
  return false;
}
function applyActionToState(state,a){
  state.trackers||=[];state.reminders||=[];state.tasks||=[];
  if(a.kind==="reminder"){
    const r=state.reminders.find(x=>x.id===a.reminderId);if(!r)return;
    if(a.action==="done"){
      if((r.repeat||"once")==="once"){r.status="completed";r.completedAt=a.at||Date.now();r.completionReason="done"}
      else{r.doneDates||={};r.doneDates[a.dateKey]=true}
    } else if(a.action==="cancel"){
      if((r.repeat||"once")==="once"){r.status="completed";r.completedAt=a.at||Date.now();r.completionReason="cancelled"}
      else{r.doneDates||={};r.doneDates[a.dateKey]=true;r.skippedDates||={};r.skippedDates[a.dateKey]=true}
    }
  } else if(a.kind==="task"){
    const t=state.tasks.find(x=>x.id===a.taskId);if(!t)return;
    if(a.action==="done"){t.status="completed";t.completedAt=a.at||Date.now();for(const s of (t.subtasks||[]))s.done=true}
    if(a.action==="cancel"){t.reminderDate="";t.reminderTime=""}
  } else if(a.kind==="tracker" && a.action==="done"){
    const tr=state.trackers.find(x=>x.id===a.trackerId);if(!tr)return;const day=trackerDay(tr,a.local||localNow("UTC"));
    const d=a.trackerDay||day;tr.done||={};tr.done[`day_${d}`]||={};tr.done[`day_${d}`][a.itemId]=true;
  }
}
function buildActionData(deviceId,kind,ids,dateKey,trackerDayNum){return {actionUrl:"https://personal-tracker-push.yanivba10.workers.dev/action",actionMapping:"direct-action-v1",deviceId,kind,dateKey,trackerDay:trackerDayNum,...ids}}
function addSnooze(data,a){data.snoozes||=[];data.snoozes.push({id:`snz_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,dueAt:Date.now()+3600000,createdAt:Date.now(),...a})}

async function processSnoozes(env,deviceId,data,now){
  if(!Array.isArray(data.snoozes)||!data.snoozes.length)return false;let changed=false;
  const keep=[];
  for(const s of data.snoozes){
    if(Number(s.dueAt)>now.getTime()){keep.push(s);continue}
    try{
      await send(env,data.subscription,{title:s.title||"תזכורת",body:s.body||"תזכורת שנדחתה בשעה",icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,tag:`snooze-${s.id}`,actions:[{action:"done",title:"בוצע"},{action:"snooze",title:"עוד שעה"}],data:{url:s.url||APP_URL,...buildActionData(deviceId,s.kind,s.ids||{},s.dateKey,s.trackerDay)}});
      pushLog(data,{kind:s.kind,snoozeId:s.id,workerAt:now.toISOString(),status:"sent-snooze"});changed=true;
    }catch(err){keep.push(s);pushLog(data,{kind:s.kind,snoozeId:s.id,workerAt:now.toISOString(),status:"error",error:String(err?.message||err)});changed=true}
  }
  data.snoozes=keep;return changed;
}

async function processClient(env,deviceId){
  const keyName=clientKey(deviceId);const data=await env.CLIENTS.get(keyName,"json");if(!data?.subscription||!data?.state?.trackers)return;
  const now=new Date();const local=localNow(data.timezone||"UTC",now),hm=localHm(local),dateKey=localDateKey(local);data.sent||={};let changed=await processSnoozes(env,deviceId,data,now);
  for(const tr of data.state.trackers.filter(t=>t.status==="active")){
    const day=trackerDay(tr,local);if(day<1||day>trackerEndDay(tr))continue;const stage=stageForDay(tr,day);if(!stage)continue;
    for(const t of (stage.tasks||[])){
      if(!t.notify||!dueWithinWindow(t.time,local)||!taskOccurs(t,day,stage,local.weekday)||isDone(tr,day,t.id))continue;
      const sentKey=`${dateKey}|tracker|${tr.id}|${t.id}`;if(data.sent[sentKey])continue;
      try{await send(env,data.subscription,{title:tr.name||"Personal Tracker",body:t.description?.trim()||`הגיע הזמן: ${t.label||"פעולה"}`,icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,tag:`pt-${tr.id}-${t.id}-${dateKey}`,actions:[{action:"done",title:"בוצע"},{action:"snooze",title:"עוד שעה"}],data:{url:`${APP_URL}?openTracker=${encodeURIComponent(tr.id)}`,...buildActionData(deviceId,"tracker",{trackerId:tr.id,itemId:t.id},dateKey,day)}});data.sent[sentKey]=Date.now();pushLog(data,{kind:"tracker",trackerId:tr.id,itemId:t.id,scheduledFor:localScheduledIso(dateKey,t.time,data.timezone),workerAt:now.toISOString(),status:"sent"});changed=true}catch(err){pushLog(data,{kind:"tracker",workerAt:now.toISOString(),status:"error",error:String(err?.message||err)});changed=true}
    }
  }
  for(const r of (data.state.reminders||[])){
    if(!r.notify||!dueWithinWindow(r.time,local)||!reminderOccurs(r,local,dateKey)||r.doneDates?.[dateKey])continue;const sentKey=`${dateKey}|reminder|${r.id}`;if(data.sent[sentKey])continue;
    try{await send(env,data.subscription,{title:`תזכורת: ${r.title||"משימה"}`,body:r.description?.trim()||"הגיע הזמן לבצע את התזכורת.",icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,tag:`ptr-${r.id}-${dateKey}`,actions:[{action:"done",title:"בוצע"},{action:"snooze",title:"עוד שעה"}],data:{url:`${APP_URL}?openReminder=${encodeURIComponent(r.id)}`,...buildActionData(deviceId,"reminder",{reminderId:r.id},dateKey)}});data.sent[sentKey]=Date.now();pushLog(data,{kind:"reminder",reminderId:r.id,scheduledFor:localScheduledIso(dateKey,r.time,data.timezone),workerAt:now.toISOString(),status:"sent"});changed=true}catch(err){pushLog(data,{kind:"reminder",workerAt:now.toISOString(),status:"error",error:String(err?.message||err)});changed=true}
  }
  for(const t of (data.state.tasks||[]).filter(x=>x.status!=="completed")){
    if(!t.reminderDate||!t.reminderTime||t.reminderDate!==dateKey||!dueWithinWindow(t.reminderTime,local))continue;const sentKey=`${dateKey}|task|${t.id}`;if(data.sent[sentKey])continue;
    try{await send(env,data.subscription,{title:`משימה: ${t.title||"משימה"}`,body:t.description?.trim()||"הגיע הזמן לטפל במשימה.",icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,tag:`ptt-${t.id}-${dateKey}`,actions:[{action:"done",title:"בוצע"},{action:"snooze",title:"עוד שעה"}],data:{url:`${APP_URL}?openTask=${encodeURIComponent(t.id)}`,...buildActionData(deviceId,"task",{taskId:t.id},dateKey)}});data.sent[sentKey]=Date.now();pushLog(data,{kind:"task",taskId:t.id,scheduledFor:localScheduledIso(dateKey,t.reminderTime,data.timezone),workerAt:now.toISOString(),status:"sent"});changed=true}catch(err){pushLog(data,{kind:"task",workerAt:now.toISOString(),status:"error",error:String(err?.message||err)});changed=true}
  }
  const cutoff=Date.now()-45*86400000;for(const [k,v] of Object.entries(data.sent))if(Number(v)<cutoff){delete data.sent[k];changed=true}
  if(changed)await env.CLIENTS.put(keyName,JSON.stringify(data));
}

export default {
  async fetch(request,env){
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:corsHeaders});const url=new URL(request.url);
    try{
      if(url.pathname==="/health")return json({ok:true,kv:!!env.CLIENTS,privateKey:!!env.VAPID_PRIVATE_KEY,scheduler:"indexed-v3",usesKvList:false,notificationActions:true,taskReminders:true,actionSync:"server-merge-v2",writeSuppression:true,catchUpMinutes:CATCH_UP_MINUTES,diagnosticsV2:true,actionMappingFix:"direct-action-v1",hotfix:"6.2.2"});
      if(url.pathname==="/config")return json({publicKey:env.VAPID_PUBLIC_KEY});
      if(url.pathname==="/pull"&&request.method==="GET"){
        const deviceId=url.searchParams.get("deviceId")||"";if(!validDeviceId(deviceId))return json({ok:false,error:"invalid device"},400);
        const data=await loadClient(env,deviceId);if(!data?.state)return json({ok:false,error:"device not registered"},404);
        return json({ok:true,state:data.state,pendingActions:Number((data.pendingActions||[]).length),updatedAt:data.updatedAt||null});
      }
      if(url.pathname==="/state"&&request.method==="POST"){
        const body=await request.json();if(!validDeviceId(body.deviceId)||!body.subscription?.endpoint||!Array.isArray(body.state?.trackers))return json({ok:false,error:"invalid payload"},400);body.state.reminders||=[];body.state.tasks||=[];
        const previous=await loadClient(env,body.deviceId);const pending=previous?.pendingActions||[];for(const a of pending)applyActionToState(body.state,a);
        const migratingTo551=body.clientVersion==="5.5.1"&&previous?.clientVersion!=="5.5.1";
        const cleaning622=body.clientVersion==="5.5.1"&&previous?.hotfix622Cleaned!==true;
        const clearLegacySnoozes=migratingTo551||cleaning622;
        const snoozes=clearLegacySnoozes?[]:(previous?.snoozes||[]);
        const next={subscription:body.subscription,timezone:body.timezone||"UTC",clientVersion:body.clientVersion||previous?.clientVersion||"",state:body.state,sent:previous?.sent||{},dispatchLog:previous?.dispatchLog||[],snoozes,pendingActions:[],hotfix622Cleaned:previous?.hotfix622Cleaned===true||cleaning622,updatedAt:previous?.updatedAt||Date.now()};
        if(clearLegacySnoozes&&previous?.snoozes?.length)pushLog(next,{kind:"maintenance",workerAt:new Date().toISOString(),status:"cleared-legacy-snoozes-v622",count:previous.snoozes.length});
        const changed=!previous||pending.length>0||migratingTo551||cleaning622||previous.timezone!==next.timezone||previous.clientVersion!==next.clientVersion||!sameSubscription(previous.subscription,next.subscription)||!sameJson(previous.state,next.state);
        if(changed){next.updatedAt=Date.now();await saveClient(env,body.deviceId,next)}
        if(!previous)await ensureIndexed(env,body.deviceId);
        return json({ok:true,state:next.state,appliedActions:pending.length,wrote:changed,clearedLegacySnoozes:clearLegacySnoozes});
      }
      if(url.pathname==="/action"&&request.method==="POST"){
        const a=await request.json();if(!validDeviceId(a.deviceId)||!["done","snooze","cancel"].includes(a.action))return json({ok:false,error:"invalid action"},400);const data=await loadClient(env,a.deviceId);if(!data?.state)return json({ok:false,error:"device not registered"},404);
        const actionRecord={id:`act_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,...a,at:Number(a.at)||Date.now()};if(a.action==="snooze"){
          let title="תזכורת",body="תזכורת שנדחתה בשעה";if(a.kind==="reminder"){const r=(data.state.reminders||[]).find(x=>x.id===a.reminderId);title=`תזכורת: ${r?.title||"תזכורת"}`;body=r?.description||body}else if(a.kind==="task"){const t=(data.state.tasks||[]).find(x=>x.id===a.taskId);title=`משימה: ${t?.title||"משימה"}`;body=t?.description||body}else if(a.kind==="tracker"){const tr=(data.state.trackers||[]).find(x=>x.id===a.trackerId);title=tr?.name||"מעקב"}
          addSnooze(data,{kind:a.kind,ids:{reminderId:a.reminderId,taskId:a.taskId,trackerId:a.trackerId,itemId:a.itemId},dateKey:a.dateKey,trackerDay:a.trackerDay,title,body,url:a.kind==="task"?`${APP_URL}?openTask=${encodeURIComponent(a.taskId||"")}`:a.kind==="reminder"?`${APP_URL}?openReminder=${encodeURIComponent(a.reminderId||"")}`:`${APP_URL}?openTracker=${encodeURIComponent(a.trackerId||"")}`});
        } else {applyActionToState(data.state,actionRecord);data.pendingActions||=[];data.pendingActions.push(actionRecord)}
        pushLog(data,{kind:a.kind,action:a.action,rawAction:a.rawAction||null,actionId:actionRecord.id,workerAt:new Date().toISOString(),status:"action-received"});await saveClient(env,a.deviceId,data);return json({ok:true,actionReceived:a.action,actionId:actionRecord.id});
      }
      if(url.pathname==="/diagnostics"&&request.method==="POST"){const body=await request.json();if(!validDeviceId(body.deviceId))return json({ok:false,error:"invalid device"},400);const data=await loadClient(env,body.deviceId);if(!data)return json({ok:false,error:"device not registered"},404);return json({ok:true,serverNow:new Date().toISOString(),timezone:data.timezone||"UTC",updatedAt:data.updatedAt||null,clientVersion:data.clientVersion||null,subscriptionActive:!!data.subscription?.endpoint,subscriptionEndpointTail:data.subscription?.endpoint?data.subscription.endpoint.slice(-18):null,dispatchLog:(data.dispatchLog||[]).slice(-40),pendingActions:(data.pendingActions||[]).length,snoozes:(data.snoozes||[]).length,stateCounts:{trackers:(data.state?.trackers||[]).length,reminders:(data.state?.reminders||[]).length,tasks:(data.state?.tasks||[]).length}})}
      if(url.pathname==="/test"&&request.method==="POST"){const body=await request.json();if(!validDeviceId(body.deviceId))return json({ok:false,error:"invalid device"},400);const data=await loadClient(env,body.deviceId);if(!data?.subscription)return json({ok:false,error:"device not registered"},404);await send(env,data.subscription,{title:"המעקבים שלי",body:"התראת הרקע פועלת ✓",icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,tag:`pt-test-${Date.now()}`,data:{url:APP_URL,kind:"test"}});pushLog(data,{kind:"test",workerAt:new Date().toISOString(),status:"sent"});await saveClient(env,body.deviceId,data);return json({ok:true})}
      return json({ok:false,error:"not found"},404);
    }catch(err){console.log(err);return json({ok:false,error:String(err?.message||err)},500)}
  },
  async scheduled(controller,env,ctx){ctx.waitUntil((async()=>{if(!env.CLIENTS)return;const idx=await loadIndex(env);for(const deviceId of idx.clients){if(!validDeviceId(deviceId))continue;try{await processClient(env,deviceId)}catch(err){console.log("process client failed",deviceId,String(err?.message||err))}}})())}
};
