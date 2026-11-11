import fs from "node:fs/promises";
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";

export type WaEventHandler=(type:string,payload:unknown)=>Promise<void>|void;
type Options={authDir:string;onEvent:WaEventHandler};
const logger=pino({level:process.env.LOG_LEVEL??"info"});
let sock:WASocket|null=null;
let options:Options|null=null;
let connecting=false;
let connectionState:"disconnected"|"connecting"|"qr"|"open"|"logged_out"="disconnected";
let qr:string|null=null;
let pairingCode:string|null=null;
let reconnectTimer:ReturnType<typeof setTimeout>|null=null;
let registered=false;

export function status(){
  return {state:connectionState,connected:connectionState==="open",phone:sock?.user?.id?.split(":")[0]??null,name:sock?.user?.name??null,registered};
}
export const currentQr=()=>qr;
export const currentPairingCode=()=>pairingCode;

export async function connect(next?:Options):Promise<void>{
  if(next) options=next;
  if(!options) throw new Error("WhatsApp connection options not configured");
  if(connecting||connectionState==="open") return;
  connecting=true; connectionState="connecting";
  try{
    await fs.mkdir(options.authDir,{recursive:true});
    const {state,saveCreds}=await useMultiFileAuthState(options.authDir);
    registered=state.creds.registered;
    const {version}=await fetchLatestBaileysVersion();
    const wa=makeWASocket({
      version,auth:state,logger:logger.child({module:"baileys"}),
      browser:["Encontre Mais","Chrome","1.0.0"],
      printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,
      generateHighQualityLinkPreview:false,
    });
    sock=wa;
    wa.ev.on("creds.update",async()=>{registered=state.creds.registered;await saveCreds();});
    wa.ev.on("connection.update",u=>{
      if(u.qr){qr=u.qr;pairingCode=null;connectionState="qr";}
      if(u.connection==="connecting")connectionState="connecting";
      if(u.connection==="open"){
        connectionState="open";qr=null;pairingCode=null;
        void options?.onEvent("connection.open",{jid:wa.user?.id??null,phone:wa.user?.id?.split(":")[0]??null});
      }
      if(u.connection==="close"){
        const code=(u.lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut=code===DisconnectReason.loggedOut;
        connectionState=loggedOut?"logged_out":"disconnected";sock=null;
        if(!loggedOut&&options&&!reconnectTimer){
          reconnectTimer=setTimeout(()=>{reconnectTimer=null;void connect().catch(e=>logger.error(e,"Reconnect failed"));},5000);
        }
      }
    });
    wa.ev.on("group-participants.update",e=>void options?.onEvent("group.participants.update",e));
    wa.ev.on("groups.update",e=>void options?.onEvent("groups.update",e));
  }catch(e){connectionState="disconnected";throw e;}
  finally{connecting=false;}
}
function requireSocket(){if(!sock||connectionState!=="open")throw new Error("WhatsApp session is not connected");return sock;}
export async function pairing(phone:string){
  const wa=sock;
  if(!wa)throw new Error("Start the WhatsApp connection before requesting a pairing code");
  if(registered)throw new Error("This WhatsApp session is already paired");
  const code=await wa.requestPairingCode(phone);
  pairingCode=code;qr=null;return code;
}
export async function logout(){
  if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=null;
  const old=sock;sock=null;connectionState="logged_out";qr=null;pairingCode=null;registered=false;
  if(old)await old.logout();
  if(options)await fs.rm(options.authDir,{recursive:true,force:true});
}
export function socket(){return requireSocket();}
type CommunityMetadata={id:string;subject:string;isCommunity:boolean;participants:Array<{id:string;admin?:string|null}>};
function child(node:any,tag:string){return (node?.content??[]).find((item:any)=>item?.tag===tag);}
function children(node:any,tag:string){return (node?.content??[]).filter((item:any)=>item?.tag===tag);}
async function communityQuery(jid:string,type:"get"|"set",content:any[]){
  const wa=requireSocket() as any;
  if(typeof wa.query!=="function")throw new Error("This Baileys build does not expose the required WhatsApp community protocol query");
  return wa.query({tag:"iq",attrs:{type,xmlns:"w:g2",to:jid},content});
}
export async function getCommunity(jid:string):Promise<CommunityMetadata>{
  const result=await communityQuery(jid,"get",[{tag:"query",attrs:{request:"interactive"}}]);
  const community=child(result,"community");
  if(!community)throw new Error("WhatsApp did not return community metadata for COMMUNITY_JID");
  const isCommunity=Boolean(child(community,"parent"));
  if(!isCommunity)throw new Error("Configured COMMUNITY_JID is not a WhatsApp community");
  const rawId=String(community.attrs?.id??jid);
  return {
    id:rawId.includes("@")?rawId:rawId+"@g.us",
    subject:String(community.attrs?.subject??""),
    isCommunity:true,
    participants:children(community,"participant").map((p:any)=>({id:String(p.attrs?.jid??""),admin:p.attrs?.type??null}))
  };
}
export async function participantAction(jid:string,phone:string,action:"add"|"remove"){
  const wa=requireSocket() as any;
  const meta=await getCommunity(jid);
  const self=String(wa.user?.id??"").split(":")[0];
  const admin=meta.participants.some(p=>p.id.split(":")[0]===self&&(p.admin==="admin"||p.admin==="superadmin"));
  if(!admin)throw new Error("The connected WhatsApp account is not an administrator of the configured community");
  const normalized=phone.replace(/\D/g,"");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const target=String(existence.jid);
  const already=meta.participants.some(p=>p.id===target||p.id.split(":")[0]===normalized);
  if(action==="add"&&already)return {phone:normalized,action,status:"already_member",jid:target};
  if(action==="remove"&&!already)return {phone:normalized,action,status:"not_member",jid:target};
  const response=await communityQuery(jid,"set",[{
    tag:action,
    attrs:action==="remove"?{linked_groups:"true"}:{},
    content:[{tag:"participant",attrs:{jid:target}}]
  }]);
  const resultNode=child(response,action);
  const participant=children(resultNode,"participant").find((p:any)=>p.attrs?.jid===target);
  if(!participant)throw new Error("WhatsApp returned no per-participant result; operation is not confirmed");
  const waStatus=String(participant.attrs?.error??"200");
  if(waStatus!=="200")throw new Error("WhatsApp rejected the community "+action+" operation (status "+waStatus+")");
  return {phone:normalized,action,status:"request_submitted",jid:target,whatsappStatus:waStatus,removesFromLinkedGroups:action==="remove"};
}
