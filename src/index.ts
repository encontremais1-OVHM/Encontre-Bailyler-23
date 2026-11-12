import "dotenv/config";
import crypto,{createHmac,timingSafeEqual} from "node:crypto";
import path from "node:path";
import express,{type Request,type Response,type NextFunction} from "express";
import helmet from "helmet";
import QRCode from "qrcode";
import {createClient} from "@supabase/supabase-js";
import {z} from "zod";
import {connect,status,currentQr,currentPairingCode,pairing,logout,getCommunity,isSelfAdmin,isSelfOwner,participantAction,listCommunities,groupParticipants,groupParticipantAction,groupInviteLink,groupProfilePicture,sendTextMessage,inspectCommunityDiscovery} from "./whatsapp.js";

const env=z.object({
  PORT:z.coerce.number().int().positive().default(8080),
  SERVICE_API_KEY:z.string().min(32),
  AUTH_DIR:z.string().default("/data/whatsapp-auth"),
  COMMUNITY_JID:z.string().regex(/^\d+(?:-\d+)?@g\.us$/),
  SUPABASE_URL:z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY:z.string().min(1),
}).parse(process.env);
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
type RawBodyRequest=Request&{rawBody?:Buffer};
const app=express();app.disable("x-powered-by");app.use(helmet());app.use(express.json({limit:"256kb",verify:(req,_res,buffer)=>{(req as RawBodyRequest).rawBody=Buffer.from(buffer);}}));
function auth(req:Request,res:Response,next:NextFunction){
  const a=Buffer.from(req.header("x-api-key")??"");const b=Buffer.from(env.SERVICE_API_KEY);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){res.status(401).json({ok:false,error:"unauthorized"});return;}next();
}
const secure=[auth];
let webhookSecretPromise:Promise<string>|null=null;
async function webhookSecret(){
  if(!webhookSecretPromise)webhookSecretPromise=(async()=>{
    const {data,error}=await db.rpc("get_whatsapp_webhook_secret");
    if(error||typeof data!=="string"||data.length<32)throw new Error("Supabase WhatsApp webhook secret is unavailable");
    return data;
  })();
  return webhookSecretPromise;
}
app.post("/internal/whatsapp/participants/add",async(req,res)=>{
  try{
    const raw=(req as RawBodyRequest).rawBody;
    const supplied=String(req.header("x-encontre-signature")||"").toLowerCase();
    if(!raw||!/^[a-f0-9]{64}$/.test(supplied)){
      res.status(401).json({ok:false,error:"invalid_internal_signature"});
      return;
    }
    const secret=await webhookSecret();
    const expected=createHmac("sha256",secret).update(raw).digest();
    const actual=Buffer.from(supplied,"hex");
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){
      res.status(401).json({ok:false,error:"invalid_internal_signature"});
      return;
    }
    const parsed=z.object({
      event_id:z.string().min(1).max(128),
      operation_id:z.string().uuid(),
      group_id:z.string().endsWith("@g.us"),
      group_type:z.enum(["community","subgroup"]),
      phone:z.string().regex(/^\d{8,15}$/),
    }).safeParse(req.body);
    if(!parsed.success){
      res.status(422).json({ok:false,error:"invalid_internal_access_payload"});
      return;
    }
    const payload=parsed.data;
    const {data:operation,error:operationError}=await db.from("access_operations")
      .select("id,member_id,whatsapp_group_id,operation_type,status")
      .eq("id",payload.operation_id).maybeSingle();
    if(operationError)throw operationError;
    if(!operation||operation.operation_type!=="add"||operation.status!=="processing"){
      res.status(409).json({ok:false,error:"access_operation_not_dispatchable"});
      return;
    }
    const [groupResult,memberResult,membershipResult]=await Promise.all([
      db.from("whatsapp_groups").select("id,external_group_id,group_type,is_active,sync_status")
        .eq("id",operation.whatsapp_group_id).maybeSingle(),
      db.from("members").select("id,phone_e164,phone").eq("id",operation.member_id).maybeSingle(),
      db.from("group_memberships").select("id,status")
        .eq("member_id",operation.member_id).eq("whatsapp_group_id",operation.whatsapp_group_id).maybeSingle(),
    ]);
    if(groupResult.error)throw groupResult.error;
    if(memberResult.error)throw memberResult.error;
    if(membershipResult.error)throw membershipResult.error;
    const group=groupResult.data;
    const member=memberResult.data;
    const membership=membershipResult.data;
    const storedPhone=String(member?.phone_e164||member?.phone||"").replace(/\D/g,"");
    if(!group||group.external_group_id!==payload.group_id||group.group_type!==payload.group_type||!group.is_active||
       !member||storedPhone!==payload.phone||!membership||!["pending_invitation","invited","joined"].includes(membership.status)){
      res.status(409).json({ok:false,error:"access_operation_context_mismatch"});
      return;
    }
    if(membership.status==="joined"){
      res.status(200).json({ok:true,data:{status:"already_member",phone:payload.phone,action:"add"}});
      return;
    }
    const result=await groupParticipantAction(group.external_group_id,payload.phone,"add",env.COMMUNITY_JID);
    if(result.status==="already_member"){
      await forwardParticipantEvents({action:"add",id:group.external_group_id,participants:[result.jid]});
      res.status(200).json({ok:true,data:result,confirmation:"Existing WhatsApp membership verified and reconciled."});
      return;
    }
    res.status(202).json({ok:true,data:result,confirmation:"Request submitted; membership is pending the signed WhatsApp participant event."});
  }catch(error){
    console.error("Internal WhatsApp access operation failed",error instanceof Error?error.message:"unknown error");
    res.status(502).json({ok:false,error:"internal_whatsapp_access_failed",message:error instanceof Error?error.message:"Unknown error"});
  }
});

async function forwardParticipantEvents(payload:any){
  const action=String(payload?.action||"");
  if(!["add","remove"].includes(action))return;
  const groupId=String(payload?.id||"");
  if(!groupId.endsWith("@g.us"))return;
  const participants=Array.isArray(payload?.participants)?payload.participants:[];
  const secret=await webhookSecret();
  for(const item of participants){
    const participantJid=String(typeof item==="string"?item:item?.id||item?.jid||"");
    if(!participantJid)continue;
    const event={
      event:action==="add"?"whatsapp.participant_added":"whatsapp.participant_removed",
      action,group_id:groupId,participant_jid:participantJid,
      event_id:crypto.randomUUID(),occurred_at:new Date().toISOString()
    };
    const raw=JSON.stringify(event);
    const signature=createHmac("sha256",secret).update(raw).digest("hex");
    const response=await fetch(env.SUPABASE_URL.replace(/\/+$/,"")+"/functions/v1/whatsapp-confirmation",{
      method:"POST",headers:{"content-type":"application/json","x-encontre-signature":signature},body:raw
    });
    if(!response.ok)console.error("Supabase participant event rejected",response.status,(await response.text()).slice(0,300));
  }
}
void connect({authDir:path.resolve(env.AUTH_DIR),onEvent:async(type,payload)=>{
  if(type==="group.participants.update"){
    try{await forwardParticipantEvents(payload);}catch(e){console.error("Supabase participant event forwarding failed",e);}
  }
}}).catch(e=>console.error("WhatsApp startup failed",e));

app.get("/health",(_req,res)=>res.json({ok:true,service:"encontre-mais-community-whatsapp-api",provider:"baileys-whatsapp-web",whatsapp:{state:status().state,connected:status().connected}}));
app.get("/v1/session",...secure,(_req,res)=>res.json({ok:true,data:{...status(),qrAvailable:Boolean(currentQr()),pairingCodeAvailable:Boolean(currentPairingCode())}}));
app.post("/v1/session/connect",...secure,async(_req,res)=>{
  try{await connect();res.status(202).json({ok:true,data:status()});}
  catch(e){res.status(500).json({ok:false,error:"connect_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.get("/v1/session/qr",...secure,async(_req,res)=>{
  const qr=currentQr();if(!qr){res.status(404).json({ok:false,error:"qr_not_available",data:status()});return;}
  res.json({ok:true,data:{qr,qrDataUrl:await QRCode.toDataURL(qr),expiresInSeconds:60}});
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
app.get("/v1/community/diagnostics",...secure,async(_req,res)=>{
  try{res.json({ok:true,data:await inspectCommunityDiscovery(env.COMMUNITY_JID)});}
  catch(e){res.status(502).json({ok:false,error:"community_diagnostics_failed",message:e instanceof Error?e.message:"Unknown error"});}
});
app.get("/v1/community",...secure,async(_req,res)=>{
  try{
    const c=await getCommunity(env.COMMUNITY_JID);
    const isOwner=await isSelfOwner(c.owner,c.ownerPn);
    const isAdmin=await isSelfAdmin(c.participants,c.owner,c.ownerPn);
    if(isAdmin===null)throw new Error("Community permissions could not be verified because the connected account PN/LID identity could not be matched to the WhatsApp participant list or owner metadata");
    res.json({ok:true,data:{id:c.id,subject:c.subject,isCommunity:c.isCommunity,participantCount:c.participants.length,connectedAccount:status().phone,isOwner,accountRole:isOwner?"owner":isAdmin?"admin":"member",isAdmin,adminStatus:isAdmin?"admin":"not_admin"}});
  }catch(e){
    const statusCode=(e as any)?.output?.statusCode??(e as any)?.statusCode;
    res.status(statusCode===403?403:502).json({ok:false,error:"community_unavailable",message:e instanceof Error?e.message:"Unknown error"});
  }
});
app.get("/v1/communities",...secure,async(_req,res)=>{
  try{res.json({ok:true,data:{communities:await listCommunities(env.COMMUNITY_JID)}});}
  catch(e){res.status(502).json({ok:false,error:"communities_unavailable",message:e instanceof Error?e.message:"Unknown error"});}
});
app.get("/v1/groups/:jid/participants",...secure,async(req,res)=>{
  try{res.json({ok:true,data:{participants:await groupParticipants(String(req.params.jid),env.COMMUNITY_JID)}});}
  catch(e){res.status(502).json({ok:false,error:"participants_unavailable",message:e instanceof Error?e.message:"Unknown error"});}
});
for(const action of ["add","remove"] as const){
  app.post("/v1/groups/:jid/participants/"+action,...secure,async(req,res)=>{
    const parsed=participantBody.safeParse(req.body);
    if(!parsed.success){res.status(400).json({ok:false,error:"invalid_phone_number"});return;}
    try{
      const result=await groupParticipantAction(String(req.params.jid),parsed.data.phoneNumber,action,env.COMMUNITY_JID);
      res.status(result.status==="request_submitted"?202:200).json({ok:true,data:result,confirmation:"A resposta da operação não é prova de alteração de participação. Aguarde o evento real do WhatsApp ou reconcilie a lista de participantes."});
    }catch(e){res.status(502).json({ok:false,error:"group_participant_operation_failed",message:e instanceof Error?e.message:"Unknown error"});}
  });
}
app.get("/v1/groups/:jid/invite-link",...secure,async(req,res)=>{
  try{res.json({ok:true,data:{inviteLink:await groupInviteLink(String(req.params.jid))}});}
  catch(e){res.status(502).json({ok:false,error:"invite_link_unavailable",message:e instanceof Error?e.message:"Unknown error"});}
});
app.get("/v1/groups/:jid/profile-picture",...secure,async(req,res)=>{
  try{res.json({ok:true,data:{profilePictureUrl:await groupProfilePicture(String(req.params.jid))}});}
  catch(e){res.status(502).json({ok:false,error:"profile_picture_unavailable",message:e instanceof Error?e.message:"Unknown error"});}
});
app.post("/v1/messages/send",...secure,async(req,res)=>{
  const parsed=z.object({phoneNumber:z.string().regex(/^\+?[1-9]\d{7,14}$/),message:z.string().min(1).max(4000)}).safeParse(req.body);
  if(!parsed.success){res.status(400).json({ok:false,error:"invalid_message_request"});return;}
  try{res.json({ok:true,data:await sendTextMessage(parsed.data.phoneNumber,parsed.data.message)});}
  catch(e){res.status(502).json({ok:false,error:"message_send_failed",message:e instanceof Error?e.message:"Unknown error"});}
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
