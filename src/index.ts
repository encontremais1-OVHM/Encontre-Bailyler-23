import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import express,{type Request,type Response,type NextFunction} from "express";
import helmet from "helmet";
import QRCode from "qrcode";
import {createClient} from "@supabase/supabase-js";
import {z} from "zod";
import {connect,status,currentQr,currentPairingCode,pairing,logout,getCommunity,participantAction} from "./whatsapp.js";

const env=z.object({
  PORT:z.coerce.number().int().positive().default(8080),
  SERVICE_API_KEY:z.string().min(32),
  AUTH_DIR:z.string().default("/data/whatsapp-auth"),
  COMMUNITY_JID:z.string().regex(/^\d+(?:-\d+)?@g\.us$/),
  SUPABASE_URL:z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY:z.string().min(1),
  SUPABASE_EVENTS_TABLE:z.string().default("whatsapp_web_events")
}).parse(process.env);
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const app=express();app.disable("x-powered-by");app.use(helmet());app.use(express.json({limit:"256kb"}));
function auth(req:Request,res:Response,next:NextFunction){
  const a=Buffer.from(req.header("x-api-key")??"");const b=Buffer.from(env.SERVICE_API_KEY);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){res.status(401).json({ok:false,error:"unauthorized"});return;}next();
}
const secure=[auth];
async function saveEvent(type:string,payload:unknown){
  const stable=JSON.stringify({type,payload});
  const id=crypto.randomUUID();
  const {error}=await db.from(env.SUPABASE_EVENTS_TABLE).upsert({
    provider:"baileys_whatsapp_web",event_type:type,external_event_id:id,payload,
    received_at:new Date().toISOString(),processing_status:"received"
  },{onConflict:"external_event_id",ignoreDuplicates:true});
  if(error)throw error;
}
void connect({authDir:path.resolve(env.AUTH_DIR),onEvent:async(type,payload)=>{
  if(type==="group.participants.update" && (payload as {id?:string})?.id!==env.COMMUNITY_JID) return;
  try{await saveEvent(type,payload);}catch(e){console.error("Supabase event persistence failed",type,e);}
}}).catch(e=>console.error("WhatsApp startup failed",e));

app.get("/health",(_req,res)=>res.json({ok:true,service:"encontre-mais-community-whatsapp-api",provider:"baileys-whatsapp-web",whatsapp:status()}));
app.get("/v1/session",...secure,(_req,res)=>res.json({ok:true,data:{...status(),qrAvailable:Boolean(currentQr()),pairingCode:currentPairingCode()}}));
app.post("/v1/session/connect",...secure,async(_req,res)=>{
  try{await connect();res.status(202).json({ok:true,data:status()});}
  catch(e){res.status(500).json({ok:false,error:"connect_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.get("/v1/session/qr",...secure,async(_req,res)=>{
  const qr=currentQr();if(!qr){res.status(404).json({ok:false,error:"qr_not_available",data:status()});return;}
  res.json({ok:true,data:{qr,qrDataUrl:await QRCode.toDataURL(qr)}});
});
app.post("/v1/session/pairing-code",...secure,async(req,res)=>{
  const parsed=z.object({phoneNumber:z.string().regex(/^\+?[1-9]\d{7,14}$/)}).safeParse(req.body);
  if(!parsed.success){res.status(400).json({ok:false,error:"invalid_phone_number"});return;}
  try{res.json({ok:true,data:{pairingCode:await pairing(parsed.data.phoneNumber.replace(/\D/g,""))}});}
  catch(e){res.status(409).json({ok:false,error:"pairing_code_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.post("/v1/session/logout",...secure,async(_req,res)=>{
  try{await logout();res.json({ok:true,data:status()});}
  catch(e){res.status(500).json({ok:false,error:"logout_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.get("/v1/community",...secure,async(_req,res)=>{
  try{const c=await getCommunity(env.COMMUNITY_JID);res.json({ok:true,data:{id:c.id,subject:c.subject,isCommunity:c.isCommunity,participantCount:c.participants.length,connectedAccount:status().phone}});}
  catch(e){res.status(502).json({ok:false,error:"community_unavailable",message:e instanceof Error?e.message:"Unknown error"});}
});
const participantBody=z.object({phoneNumber:z.string().regex(/^\+?[1-9]\d{7,14}$/)});
app.post("/v1/community/participants/add",...secure,async(req,res)=>{
  const parsed=participantBody.safeParse(req.body);if(!parsed.success){res.status(400).json({ok:false,error:"invalid_phone_number"});return;}
  try{const result=await participantAction(env.COMMUNITY_JID,parsed.data.phoneNumber,"add");res.status(result.status==="request_submitted"?202:200).json({ok:true,data:result,confirmation:"A resposta da operação não é prova de adesão. Aguarde group.participants.update e reconcilie o membro no Supabase."});}
  catch(e){res.status(502).json({ok:false,error:"community_add_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.post("/v1/community/participants/remove",...secure,async(req,res)=>{
  const parsed=participantBody.safeParse(req.body);if(!parsed.success){res.status(400).json({ok:false,error:"invalid_phone_number"});return;}
  try{const result=await participantAction(env.COMMUNITY_JID,parsed.data.phoneNumber,"remove");res.status(result.status==="request_submitted"?202:200).json({ok:true,data:result,confirmation:"A resposta da operação não é prova de remoção. Aguarde group.participants.update e reconcilie o estado."});}
  catch(e){res.status(502).json({ok:false,error:"community_remove_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{console.error("Unhandled API error",err);res.status(500).json({ok:false,error:"internal_error"});});
app.listen(env.PORT,"0.0.0.0",()=>console.log("Encontre Mais community API listening on "+env.PORT));
