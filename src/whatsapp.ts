import fs from "node:fs/promises";
import path from "node:path";
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState, resolveWaWebVersion, type WASocket } from "@chaeulso/baileys";
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
let lastError:string|null=null;
let reconnectAttempt=0;

export function status(){
  return {state:connectionState,connected:connectionState==="open",phone:sock?.user?.id?.split(":")[0]??null,name:sock?.user?.name??null,registered,lastError};
}
export const currentQr=()=>qr;
export const currentPairingCode=()=>pairingCode;

export async function connect(next?:Options):Promise<void>{
  if(next) options=next;
  if(!options) throw new Error("WhatsApp connection options not configured");
  if(connecting||connectionState==="open") return;
  connecting=true; connectionState="connecting";lastError=null;
  try{
    await fs.mkdir(options.authDir,{recursive:true});
    let auth=await useMultiFileAuthState(options.authDir);
    // Never delete an unregistered identity automatically here. QR pairing can
    // be accepted by WhatsApp immediately before stream:error 515 asks the
    // companion to restart. The saved creds.me is required to finish that
    // handshake on the next socket; deleting it breaks successful QR scans.
    const {state,saveCreds}=auth;
    registered=state.creds.registered;
    const versionResult=await resolveWaWebVersion({cachePath:path.join(options.authDir,"wa-version.json")});
    const version=versionResult.version;
    logger.info({version,source:versionResult.source,isLatest:versionResult.isLatest},"WhatsApp Web protocol version selected");
    const wa=makeWASocket({
      version,auth:state,logger:logger.child({module:"baileys"}),
      // Use a recognised browser descriptor. WhatsApp rejects product-branded platform labels during phone pairing.
      browser:Browsers.macOS("Chrome"),
      printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,
      generateHighQualityLinkPreview:false,
    });
    sock=wa;
    wa.ev.on("creds.update",async()=>{registered=state.creds.registered;await saveCreds();});
    wa.ev.on("connection.update",u=>{
      if(u.qr){qr=u.qr;pairingCode=null;connectionState="qr";}
      if(u.connection==="connecting")connectionState="connecting";
      if(u.connection==="open"){
        connectionState="open";qr=null;pairingCode=null;lastError=null;reconnectAttempt=0;
        void options?.onEvent("connection.open",{jid:wa.user?.id??null,phone:wa.user?.id?.split(":")[0]??null});
      }
      if(u.connection==="close"){
        const disconnectError=u.lastDisconnect?.error as any;
        const code=disconnectError?.output?.statusCode;
        lastError=disconnectError?.message || "WhatsApp connection closed"+(code?" (code "+code+")":"");
        logger.warn({statusCode:code,error:lastError},"WhatsApp connection closed");
        const loggedOut=code===DisconnectReason.loggedOut;
        connectionState=loggedOut?"logged_out":"disconnected";sock=null;qr=null;pairingCode=null;
        if(!loggedOut&&options&&!reconnectTimer){
          // WhatsApp deliberately closes the stream with 515 after a device
          // has been paired. This is a protocol instruction to reconnect now,
          // not a failed login. Preserve auth and restart without exponential
          // backoff so the QR handshake can finish promptly.
          const restartRequired=code===DisconnectReason.restartRequired;
          const delay=restartRequired?250:Math.min(5000*Math.pow(2,reconnectAttempt),60000);
          if(restartRequired)reconnectAttempt=0;
          else reconnectAttempt+=1;
          logger.info({statusCode:code,delay,restartRequired},"Scheduling WhatsApp reconnect");
          reconnectTimer=setTimeout(()=>{reconnectTimer=null;void connect().catch(e=>logger.error(e,"Reconnect failed"));},delay);
        }
      }
    });
    wa.ev.on("group-participants.update",e=>void options?.onEvent("group.participants.update",e));
    wa.ev.on("groups.update",e=>void options?.onEvent("groups.update",e));
  }catch(e){connectionState="disconnected";lastError=e instanceof Error?e.message:"WhatsApp startup failed";throw e;}
  finally{connecting=false;}
}
function requireSocket(){if(!sock||connectionState!=="open")throw new Error("WhatsApp session is not connected");return sock;}
export async function pairing(phone:string){
  if(!sock&&!connecting)await connect();
  // The service starts the socket asynchronously. Wait briefly if the admin
  // requests a phone pairing code while that startup is still in progress.
  if(!sock&&connecting){
    const deadline=Date.now()+15000;
    while(!sock&&connecting&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  }
  const wa=sock;
  if(!wa)throw new Error("WhatsApp connection is still starting. Try generating the pairing code again in a moment.");
  if(registered)throw new Error("This WhatsApp session is already paired");
  // Switch the panel to phone-code mode so a previously displayed QR cannot
  // remain visible while the server validates the pairing registration.
  pairingCode=null;qr=null;connectionState="connecting";lastError=null;
  try {
    const code=await wa.requestPairingCode(phone);
    pairingCode=code;
    lastError=null;
    return code;
  } catch(error) {
    lastError=error instanceof Error?error.message:"Could not request a WhatsApp pairing code";
    throw error;
  }
}
export async function logout(){
  if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=null;
  const old=sock;sock=null;connectionState="logged_out";qr=null;pairingCode=null;registered=false;
  if(old)await old.logout();
  if(options)await fs.rm(options.authDir,{recursive:true,force:true});
}
export function socket(){return requireSocket();}
type CommunityParticipant={id:string;admin?:string|null;phoneNumber?:string|null;lid?:string|null};
type CommunityMetadata={id:string;subject:string;isCommunity:boolean;participants:CommunityParticipant[]};
function normalizeJid(value:string){
  const jid=String(value||"").trim().toLowerCase();
  if(!jid)return "";
  const at=jid.lastIndexOf("@");
  if(at<0)return /^\\d+$/.test(jid)?jid+"@s.whatsapp.net":jid;
  return jid.slice(0,at).split(":")[0]+"@"+jid.slice(at+1);
}
function phoneFromJid(jid:string){return normalizeJid(jid).split("@")[0];}
function isLidJid(jid:string){return jid.endsWith("@lid")||jid.endsWith("@hosted.lid");}
function isPnJid(jid:string){return jid.endsWith("@s.whatsapp.net")||jid.endsWith("@hosted");}
async function jidAliases(wa:any,...values:Array<string|null|undefined>){
  const aliases=new Set<string>();
  const add=(value:string|null|undefined)=>{
    if(!value)return;
    const normalized=normalizeJid(value);
    if(normalized)aliases.add(normalized);
  };
  for(const value of values)add(value);
  const mapping=wa?.signalRepository?.lidMapping;
  const initial=[...aliases];
  for(const jid of initial){
    try{
      // Resolve LID -> PN only. Reverse PN -> LID may trigger a network
      // USync lookup for every participant; Baileys metadata already supplies
      // phoneNumber/lid aliases when available.
      if(isLidJid(jid)&&typeof mapping?.getPNForLID==="function")add(await mapping.getPNForLID(jid));
    }catch(error){
      logger.debug({jid,error:error instanceof Error?error.message:"LID mapping unavailable"},"Could not resolve WhatsApp PN/LID alias");
    }
  }
  return aliases;
}
async function sameWhatsAppUser(wa:any,left:CommunityParticipant,rightJid:string){
  const leftAliases=await jidAliases(wa,left.id,left.phoneNumber,left.lid);
  const rightAliases=await jidAliases(wa,rightJid);
  return [...leftAliases].some(alias=>rightAliases.has(alias));
}
export async function isSelfAdmin(participants:CommunityParticipant[]):Promise<boolean|null>{
  const wa=requireSocket() as any;
  const selfJid=String(wa.user?.id??"");
  if(!selfJid)throw new Error("WhatsApp did not expose the connected account identity; administrator permissions cannot be verified");
  const selfAliases=await jidAliases(wa,selfJid,String(wa.user?.lid??""),String(wa.user?.phoneNumber??""));
  if(selfAliases.size===0)throw new Error("Could not resolve the connected WhatsApp account identity; administrator permissions cannot be verified");
  const selfIsLid=isLidJid(normalizeJid(selfJid));
  const selfHasPn=[...selfAliases].some(isPnJid);
  let selfFound=false;
  let unresolvedParticipantIdentity=false;
  for(const participant of participants){
    const participantId=normalizeJid(participant.id);
    const participantAliases=await jidAliases(wa,participant.id,participant.phoneNumber,participant.lid);
    if([...participantAliases].some(alias=>selfAliases.has(alias))){
      selfFound=true;
      if(participant.admin==="admin"||participant.admin==="superadmin")return true;
      continue;
    }
    const participantHasPn=[...participantAliases].some(isPnJid);
    const participantHasLid=[...participantAliases].some(isLidJid);
    if(isLidJid(participantId)&&!participantHasPn)unresolvedParticipantIdentity=true;
    if(selfIsLid&&!selfHasPn&&isPnJid(participantId)&&!participantHasLid)unresolvedParticipantIdentity=true;
  }
  if(selfFound)return false;
  // An unmatched LID is not proof of a different user. Keep this state
  // unknown until Baileys can resolve the PN/LID pair.
  if(unresolvedParticipantIdentity)return null;
  return false;
}
async function communityQuery(jid:string,type:"get"|"set",content:any[]){
  const wa=requireSocket() as any;
  if(typeof wa.query!=="function")throw new Error("This Baileys build does not expose the required WhatsApp community protocol query");
  return wa.query({tag:"iq",attrs:{type,xmlns:"w:g2",to:jid},content});
}
export async function getCommunity(jid:string):Promise<CommunityMetadata>{
  const wa=requireSocket() as any;
  // Baileys' groupMetadata uses the w:g2 interactive query and its maintained
  // extractGroupMetadata parser. Do not parse a guessed <community> node here:
  // the protocol response is a <group> node and may contain nested attributes.
  if(typeof wa.groupMetadata!=="function")throw new Error("This Baileys build does not expose groupMetadata for WhatsApp community verification");
  const metadata=await wa.groupMetadata(jid);
  if(!metadata||typeof metadata!=="object")throw new Error("WhatsApp returned an empty community metadata response");
  const returnedId=normalizeJid(String(metadata.id??jid));
  if(returnedId!==normalizeJid(jid))throw new Error("WhatsApp returned metadata for a different group than the configured COMMUNITY_JID");
  if(metadata.isCommunity!==true)throw new Error("Configured COMMUNITY_JID was returned as a group, not as a WhatsApp community");
  if(!Array.isArray(metadata.participants))throw new Error("WhatsApp community metadata did not include a verifiable participants list");
  return {
    id:returnedId,
    subject:String(metadata.subject??""),
    isCommunity:true,
    participants:metadata.participants.map((p:any)=>({
      id:String(p.id??p.jid??""),
      admin:p.admin??null,
      phoneNumber:p.phoneNumber?String(p.phoneNumber):null,
      lid:p.lid?String(p.lid):null
    })).filter((p:CommunityParticipant)=>Boolean(p.id))
  };
}
export async function participantAction(jid:string,phone:string,action:"add"|"remove"){
  const wa=requireSocket() as any;
  const meta=await getCommunity(jid);
  const admin=await isSelfAdmin(meta.participants);
  if(admin===null)throw new Error("The connected WhatsApp account's administrator permissions could not be verified because a PN/LID identity mapping is missing");
  if(!admin)throw new Error("The connected WhatsApp account is not an administrator of the configured community");
  const normalized=phone.replace(/\D/g,"");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const target=String(existence.jid);
  if(action==="remove" && await sameWhatsAppUser(wa,{id:String(wa.user?.id??"")},target)) throw new Error("The connected administrator account cannot remove itself from its community");
  let existingParticipant:CommunityParticipant|undefined;
  for(const participant of meta.participants){
    if(await sameWhatsAppUser(wa,participant,target)){existingParticipant=participant;break;}
  }
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
  const byId=new Map(groups.filter(g=>g?.id).map(g=>[normalizeJid(String(g.id)),g]));
  if(configuredJid&&!byId.has(normalizeJid(configuredJid))){
    byId.set(normalizeJid(configuredJid),{id:normalizeJid(configuredJid),subject:"Comunidade WhatsApp",isCommunity:true,participants:[]});
  }
  const communityGroups=[...byId.values()].filter(g=>g.isCommunity===true||normalizeJid(String(g.id))===normalizeJid(configuredJid));
  const result=[];
  for(const group of communityGroups){
    const id=normalizeJid(String(group.id));
    let meta:any=group;
    let adminStatus:"admin"|"not_admin"|"unknown"="unknown";
    let adminCheckError:string|null=null;
    if(id===normalizeJid(configuredJid)){
      try{meta={...group,...await getCommunity(id)};}
      catch(error){adminCheckError=error instanceof Error?error.message:"Community metadata could not be verified";}
    }
    if(!adminCheckError&&Array.isArray(meta.participants)){
      try{const isAdmin=await isSelfAdmin(meta.participants);adminStatus=isAdmin===null?"unknown":isAdmin?"admin":"not_admin";}
      catch(error){adminCheckError=error instanceof Error?error.message:"Administrator permissions could not be verified";}
    }else if(!adminCheckError){
      adminCheckError="WhatsApp did not return a participants list for this community";
    }
    const isAdmin=adminStatus==="admin"?true:adminStatus==="not_admin"?false:null;
    const subgroups=groups.filter(g=>normalizeJid(String(g.linkedParent||""))===id);
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
      isAdmin,
      admin_status:adminStatus,
      admin_check_error:adminCheckError,
      subgroups:childrenWithPictures,
    });
  }
  return result;
}

export async function groupParticipants(jid:string,configuredJid:string){
  const wa=requireSocket() as any;
  let metadata:any;
  if(jid===configuredJid){
    metadata=await getCommunity(jid);
  }else{
    metadata=await wa.groupMetadata(jid);
    if(metadata.isCommunity){
      try{metadata=await getCommunity(jid);}catch{}
    }
  }
  const participants=Array.isArray(metadata.participants)?metadata.participants:[];
  return participants.map((p:any)=>({
    id:String(p.id||p.jid||""),
    jid:String(p.id||p.jid||""),
    admin:Boolean(p.admin==="admin"||p.admin==="superadmin"),
    name:p.name?String(p.name):null,
  }));
}

export async function groupParticipantAction(jid:string,phone:string,action:"add"|"remove",configuredJid:string){
  const wa=requireSocket() as any;
  if(jid===configuredJid)return participantAction(jid,phone,action);
  const metadata:any=await wa.groupMetadata(jid);
  if(metadata.isCommunity)return participantAction(jid,phone,action);
  const selfIsAdmin=await isSelfAdmin(Array.isArray(metadata.participants)?metadata.participants:[]);
  if(selfIsAdmin===null)throw new Error("The connected WhatsApp account's administrator permissions could not be verified because a PN/LID identity mapping is missing");
  if(!selfIsAdmin){
    throw new Error("The connected WhatsApp account is not an administrator of this group");
  }
  const normalized=phone.replace(/\D/g,"");
  if(!/^\d{8,15}$/.test(normalized))throw new Error("Invalid WhatsApp phone number");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const target=String(existence.jid);
  if(action==="remove"&&await sameWhatsAppUser(wa,{id:String(wa.user?.id??"")},target))throw new Error("The connected administrator account cannot remove itself");
  let existing:any;
  for(const participant of (metadata.participants||[])){
    if(await sameWhatsAppUser(wa,{id:String(participant.id||""),admin:participant.admin,phoneNumber:participant.phoneNumber,lid:participant.lid},target)){existing=participant;break;}
  }
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
  const normalized=phone.replace(/\D/g,"");
  if(!/^\d{8,15}$/.test(normalized))throw new Error("Invalid WhatsApp phone number");
  if(!message.trim())throw new Error("Message cannot be empty");
  const [existence]=await wa.onWhatsApp(normalized);
  if(!existence?.exists||!existence.jid)throw new Error("The supplied phone number is not registered on WhatsApp");
  const result=await wa.sendMessage(String(existence.jid),{text:message});
  return {status:"submitted",messageId:result?.key?.id||null};
}
