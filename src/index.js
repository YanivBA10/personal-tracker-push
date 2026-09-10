import { sendPushNotification } from "@mmmike/web-push/send";

const APP_URL = "https://personal-tracker-app.pages.dev/";
const INDEX_KEY = "_meta:client-index:v1";
const MAX_LOGS = 60;
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" }
  });
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
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:timeZone||"UTC",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hour12:false,weekday:"short"
  }).formatToParts(date);
  const get=t=>parts.find(p=>p.type===t)?.value;
  const weekdays={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return {
    year:Number(get("year")),month:Number(get("month")),day:Number(get("day")),
    hour:get("hour"),minute:get("minute"),weekday:weekdays[get("weekday")]??0
  };
}
function localDateKey(local){return `${local.year}-${String(local.month).padStart(2,"0")}-${String(local.day).padStart(2,"0")}`}
function localHm(local){return `${local.hour}:${local.minute}`}
function localScheduledIso(dateKey, time, timezone){return `${dateKey}T${time}:00[${timezone||"UTC"}]`}
function pushLog(data, entry){
  data.dispatchLog ||= [];
  data.dispatchLog.push(entry);
  if(data.dispatchLog.length>MAX_LOGS)data.dispatchLog.splice(0,data.dispatchLog.length-MAX_LOGS);
}
async function send(env, subscription, payload){
  if(!subscription?.endpoint)throw new Error("missing subscription");
  if(!env.VAPID_PRIVATE_KEY)throw new Error("VAPID_PRIVATE_KEY is not configured");
  return sendPushNotification(subscription,payload,{
    publicKey:env.VAPID_PUBLIC_KEY,
    privateKey:env.VAPID_PRIVATE_KEY,
    subject:env.VAPID_SUBJECT||APP_URL
  },{ttl:3600,urgency:"high"});
}
async function loadClient(env,deviceId){
  if(!env.CLIENTS)throw new Error("CLIENTS KV binding is not configured");
  return env.CLIENTS.get(clientKey(deviceId),"json");
}
async function saveClient(env,deviceId,data){
  if(!env.CLIENTS)throw new Error("CLIENTS KV binding is not configured");
  await env.CLIENTS.put(clientKey(deviceId),JSON.stringify(data));
}
async function loadIndex(env){
  if(!env.CLIENTS)throw new Error("CLIENTS KV binding is not configured");
  const v=await env.CLIENTS.get(INDEX_KEY,"json");
  return Array.isArray(v?.clients)?v:{version:1,clients:[]};
}
async function ensureIndexed(env, deviceId){
  const idx=await loadIndex(env);
  if(idx.clients.includes(deviceId))return false;
  idx.clients.push(deviceId);
  idx.updatedAt=Date.now();
  await env.CLIENTS.put(INDEX_KEY,JSON.stringify(idx));
  return true;
}
async function processClient(env,deviceId){
  const keyName=clientKey(deviceId);
  const data=await env.CLIENTS.get(keyName,"json");
  if(!data?.subscription||!data?.state?.trackers)return;
  const now=new Date();
  const local=localNow(data.timezone||"UTC",now), hm=localHm(local), dateKey=localDateKey(local);
  data.sent ||= {};
  let changed=false;
  for(const tr of data.state.trackers.filter(t=>t.status==="active")){
    const day=trackerDay(tr,local);if(day<1||day>trackerEndDay(tr))continue;
    const stage=stageForDay(tr,day);if(!stage)continue;
    for(const t of (stage.tasks||[])){
      if(!t.notify||t.time!==hm||!taskOccurs(t,day,stage,local.weekday)||isDone(tr,day,t.id))continue;
      const sentKey=`${dateKey}|tracker|${tr.id}|${t.id}`;if(data.sent[sentKey])continue;
      const baseLog={kind:"tracker",trackerId:tr.id,itemId:t.id,scheduledFor:localScheduledIso(dateKey,t.time,data.timezone),workerAt:now.toISOString()};
      try{
        await send(env,data.subscription,{
          title:tr.name||"Personal Tracker",
          body:t.description?.trim()||`הגיע הזמן: ${t.label||"פעולה"}`,
          icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,
          tag:`pt-${tr.id}-${t.id}-${dateKey}`,data:{url:APP_URL,kind:"tracker",trackerId:tr.id,itemId:t.id,dateKey}
        });
        data.sent[sentKey]=Date.now();pushLog(data,{...baseLog,status:"sent"});changed=true;
      }catch(err){pushLog(data,{...baseLog,status:"error",error:String(err?.message||err)});changed=true;console.log("push failed",String(err?.message||err));}
    }
  }
  for(const r of (data.state.reminders||[]).filter(x=>x.status!=="completed")){
    if(!r.notify||r.time!==hm||!r.date)continue;
    const start=parseYmd(r.date);if(!start.y)continue;
    const todayNum=dayNumber(local.year,local.month,local.day),startNum=dayNumber(start.y,start.m,start.d);if(todayNum<startNum)continue;
    let occurs=false;
    if((r.repeat||"once")==="once")occurs=todayNum===startNum;
    else if(r.repeat==="daily")occurs=true;
    else if(r.repeat==="weekly"){
      const startWeekday=new Date(Date.UTC(start.y,start.m-1,start.d)).getUTCDay();occurs=local.weekday===startWeekday;
    }
    if(!occurs)continue;
    if(r.repeat!=="once"&&r.doneDates?.[dateKey])continue;
    const sentKey=`${dateKey}|reminder|${r.id}`;if(data.sent[sentKey])continue;
    const baseLog={kind:"reminder",reminderId:r.id,scheduledFor:localScheduledIso(dateKey,r.time,data.timezone),workerAt:now.toISOString()};
    try{
      await send(env,data.subscription,{
        title:`תזכורת: ${r.title||"משימה"}`,
        body:r.description?.trim()||"הגיע הזמן לבצע את התזכורת.",
        icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,
        tag:`ptr-${r.id}-${dateKey}`,data:{url:APP_URL,kind:"reminder",reminderId:r.id,dateKey}
      });
      data.sent[sentKey]=Date.now();pushLog(data,{...baseLog,status:"sent"});changed=true;
    }catch(err){pushLog(data,{...baseLog,status:"error",error:String(err?.message||err)});changed=true;console.log("reminder push failed",String(err?.message||err));}
  }
  const cutoff=Date.now()-45*86400000;
  for(const [k,v] of Object.entries(data.sent))if(Number(v)<cutoff){delete data.sent[k];changed=true}
  if(changed)await env.CLIENTS.put(keyName,JSON.stringify(data));
}

export default {
  async fetch(request, env) {
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:corsHeaders});
    const url=new URL(request.url);
    try{
      if(url.pathname==="/health")return json({ok:true,kv:!!env.CLIENTS,privateKey:!!env.VAPID_PRIVATE_KEY,scheduler:"indexed-v1",usesKvList:false});
      if(url.pathname==="/config")return json({publicKey:env.VAPID_PUBLIC_KEY});
      if(url.pathname==="/state" && request.method==="POST"){
        const body=await request.json();
        if(!validDeviceId(body.deviceId)||!body.subscription?.endpoint||!Array.isArray(body.state?.trackers))return json({ok:false,error:"invalid payload"},400);
        body.state.reminders ||= [];
        const previous=await loadClient(env,body.deviceId);
        await saveClient(env,body.deviceId,{
          subscription:body.subscription,timezone:body.timezone||"UTC",state:body.state,
          sent:previous?.sent||{},dispatchLog:previous?.dispatchLog||[],updatedAt:Date.now()
        });
        await ensureIndexed(env,body.deviceId);
        return json({ok:true});
      }
      if(url.pathname==="/diagnostics" && request.method==="POST"){
        const body=await request.json();if(!validDeviceId(body.deviceId))return json({ok:false,error:"invalid device"},400);
        const data=await loadClient(env,body.deviceId);if(!data)return json({ok:false,error:"device not registered"},404);
        return json({ok:true,serverNow:new Date().toISOString(),timezone:data.timezone||"UTC",updatedAt:data.updatedAt||null,dispatchLog:(data.dispatchLog||[]).slice(-20)});
      }
      if(url.pathname==="/test" && request.method==="POST"){
        const body=await request.json();if(!validDeviceId(body.deviceId))return json({ok:false,error:"invalid device"},400);
        const data=await loadClient(env,body.deviceId);if(!data?.subscription)return json({ok:false,error:"device not registered"},404);
        const now=new Date();
        await send(env,data.subscription,{
          title:"המעקבים שלי",body:"התראת הרקע פועלת ✓",
          icon:`${APP_URL}icon.svg`,badge:`${APP_URL}icon.svg`,
          tag:`pt-test-${Date.now()}`,data:{url:APP_URL,kind:"test"}
        });
        data.dispatchLog ||= [];pushLog(data,{kind:"test",workerAt:now.toISOString(),status:"sent"});
        await env.CLIENTS.put(clientKey(body.deviceId),JSON.stringify(data));
        return json({ok:true});
      }
      return json({ok:false,error:"not found"},404);
    }catch(err){
      console.log(err);return json({ok:false,error:String(err?.message||err)},500);
    }
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil((async()=>{
      if(!env.CLIENTS)return;
      const idx=await loadIndex(env);
      for(const deviceId of idx.clients){
        if(!validDeviceId(deviceId))continue;
        try{await processClient(env,deviceId)}catch(err){console.log("process client failed",deviceId,String(err?.message||err));}
      }
    })());
  }
};
