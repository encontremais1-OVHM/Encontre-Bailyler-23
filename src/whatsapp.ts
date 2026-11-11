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
function phoneFromJid(jid:string){return jid.split("@")[0].split(":")[0];}
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
  const self=phoneFromJid(String(wa.user?.id??""));
  const admin=meta.participants.some(p=>phoneFromJid(p.id)===self&&(p.admin==="admin"||p.admin==="superadmin"));
  if(!admin)throw new Error("The connected WhatsApp account is not an administrator of the configured community");
  const normalized=phone.replace(/\D/g,"");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const target=String(existence.jid);
  if(action==="remove" && phoneFromJid(target)===self) throw new Error("The connected administrator account cannot remove itself from its community");
  const existingParticipant=meta.participants.find(p=>p.id===target||phoneFromJid(p.id)===normalized);
  const already=Boolean(existingParticipant);
  if(action==="remove" && existingParticipant && (existingParticipant.admin==="admin"||existingParticipant.admin==="superadmin")){
    throw new Error("Refusing to remove a community administrator; administrator removal requires a separate manual review");
  }
  if(action==="add"&&already)return {phone:normalized,action,status:"already_member",jid:target};
  if(action==="remove"&&!already)return {phone:normalized,action,status:"not_member",jid:target};
  const response=await communityQuery(jid,"set",[
    {
      tag:action,
      attrs:action==="remove"?{linked_groups:"true"}:{},
      content:[{tag:"participant",attrs:{jid:target}}]
    }
  ]);
  const resultNode=child(response,action);
  const participant=children(resultNode,"participant").find((p:any)=>p.attrs?.jid===target);
  if(!participant)throw new Error("WhatsApp returned no per-participant result; operation is not confirmed");
  const waStatus=String(participant.attrs?.error??"200");
  if(waStatus!=="200")throw new Error("WhatsApp rejected the community "+action+" operation (status "+waStatus+")");
  return {phone:normalized,action,status:"request_submitted",jid:target,whatsappStatus:waStatus,removesFromLinkedGroups:action==="remove"};
}

export async function listCommunities(configuredJid:string){
  const wa=requireSocket() as any;
  const fetched=await wa.groupFetchAllParticipating();
  const groups=Object.values(fetched||{}) as any[];
  const byId=new Map(groups.filter(g=>g?.id).map(g=>[String(g.id),g]));
  if(configuredJid && !byId.has(configuredJid)){
    const configured=await getCommunity(configuredJid);
    byId.set(configuredJid,{id:configuredJid,subject:configured.subject,isCommunity:true,participants:configured.participants});
  }
  const communityGroups=[...byId.values()].filter(g=>g.isCommunity===true || String(g.id)===configuredJid);
  const result=[];
  for(const group of communityGroups){
    const id=String(group.id);
    let meta:any=group;
    if(id===configuredJid){
      try{meta={...group,...await getCommunity(id)};}catch{}
    }
    const subgroups=groups.filter(g=>String(g.linkedParent||"")===id);
    const profile=await wa.profilePictureUrl(id,"image").catch(()=>null);
    const childrenWithPictures=[];
    for(const childGroup of subgroups){
      const childPicture=await wa.profilePictureUrl(String(childGroup.id),"image").catch(()=>null);
      childrenWithPictures.push({
        id:String(childGroup.id),
        subject:String(childGroup.subject||"Grupo WhatsApp"),
        description:childGroup.desc?String(childGroup.desc):null,
        profile_picture_url:childPicture||null,
        linked_parent_id:id,
      });
    }
    result.push({
      id,
      subject:String(meta.subject||group.subject||"Comunidade WhatsApp"),
      description:meta.desc?String(meta.desc):null,
      profile_picture_url:profile||null,
      subgroups:childrenWithPictures,
    });
  }
  return result;
}

export async function groupParticipants(jid:string,configuredJid:string){
  const wa=requireSocket() as any;
  const metadata:any=jid===configuredJid?await getCommunity(jid):await wa.groupMetadata(jid);
  const participants=Array.isArray(metadata.participants)?metadata.participants:[];
  return participants.map((p:any)=>({
    id:String(p.id||p.jid||""),
    jid:String(p.id||p.jid||""),
    admin:Boolean(p.admin==="admin"||p.admin==="superadmin"),
    name:p.name?String(p.name):null,
  }));
}

export async function groupParticipantAction(jid:string,phone:string,action:"add"|"remove",configuredJid:string){
  if(jid===configuredJid)return participantAction(jid,phone,action);
  const wa=requireSocket() as any;
  const metadata:any=await wa.groupMetadata(jid);
  const self=phoneFromJid(String(wa.user?.id??""));
  const selfParticipant=(metadata.participants||[]).find((p:any)=>phoneFromJid(String(p.id||""))===self);
  if(!selfParticipant||!(selfParticipant.admin==="admin"||selfParticipant.admin==="superadmin")){
    throw new Error("The connected WhatsApp account is not an administrator of this group");
  }
  const normalized=phone.replace(/\\D/g,"");
  if(!/^\\d{8,15}$/.test(normalized))throw new Error("Invalid WhatsApp phone number");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const target=String(existence.jid);
  if(action==="remove"&&phoneFromJid(target)===self)throw new Error("The connected administrator account cannot remove itself");
  const existing=(metadata.participants||[]).find((p:any)=>phoneFromJid(String(p.id||""))===normalized);
  if(action==="remove"&&existing&&(existing.admin==="admin"||existing.admin==="superadmin")){
    throw new Error("Refusing to remove a group administrator");
  }
  if(action==="add"&&existing)return {phone:normalized,action,status:"already_member",jid:target};
  if(action==="remove"&&!existing)return {phone:normalized,action,status:"not_member",jid:target};
  const response=await wa.groupParticipantsUpdate(jid,[target],action);
  const result=Array.isArray(response)?response[0]:null;
  if(!result||String(result.status||"200")!=="200")throw new Error("WhatsApp did not accept the group participant operation");
  return {phone:normalized,action,status:"request_submitted",jid:target,whatsappStatus:String(result.status||"200")};
}

export async function groupInviteLink(jid:string){
  const wa=requireSocket() as any;
  const code=await wa.groupInviteCode(jid);
  if(!code)throw new Error("WhatsApp did not return an invite code");
  return "https://chat.whatsapp.com/"+code;
}

export async function groupProfilePicture(jid:string){
  const wa=requireSocket() as any;
  return await wa.profilePictureUrl(jid,"image").catch(()=>null);
}

export async function sendTextMessage(phone:string,message:string){
  const wa=requireSocket() as any;
  const normalized=phone.replace(/\\D/g,"");
  if(!/^\\d{8,15}$/.test(normalized))throw new Error("Invalid WhatsApp phone number");
  if(!message.trim())throw new Error("Message cannot be empty");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const result=await wa.sendMessage(String(existence.jid),{text:message});
  return {status:"submitted",messageId:result?.key?.id||null};
}
