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
        communitySnapshotCache=null;communitySnapshotCooldownUntil=0;communitySnapshotInFlight=null;
        connectionState="open";qr=null;pairingCode=null;lastError=null;reconnectAttempt=0;
        void options?.onEvent("connection.open",{jid:wa.user?.id??null,phone:wa.user?.id?.split(":")[0]??null});
      }
      if(u.connection==="close"){
        const disconnectError=u.lastDisconnect?.error as any;
        const code=disconnectError?.output?.statusCode;
        lastError=disconnectError?.message || "WhatsApp connection closed"+(code?" (code "+code+")":"");
        logger.warn({statusCode:code,error:lastError},"WhatsApp connection closed");
        const loggedOut=code===DisconnectReason.loggedOut;
        communitySnapshotCache=null;communitySnapshotCooldownUntil=0;communitySnapshotInFlight=null;
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
type CommunityParticipant={id:string;admin?:string|null;phoneNumber?:string|null;lid?:string|null;isAdmin?:boolean;isSuperAdmin?:boolean};
type CommunityMetadata={id:string;subject:string;isCommunity:boolean;addressingMode:string;participants:CommunityParticipant[];owner:string|null;ownerPn:string|null};
function findNode(node:any,tag:string){return Array.isArray(node?.content)?node.content.find((item:any)=>item?.tag===tag)??null:null;}
function findNodes(node:any,tag:string){return Array.isArray(node?.content)?node.content.filter((item:any)=>item?.tag===tag):[];}
function normalizeJid(value:string){
  const jid=String(value||"").trim().toLowerCase();
  if(!jid)return "";
  const at=jid.lastIndexOf("@");
  if(at<0)return /^\d+$/.test(jid)?jid+"@s.whatsapp.net":jid;
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
async function resolveWhatsAppParticipant(wa:any,phone:string){
  const normalized=String(phone||"").replace(/\D/g,"");
  if(!/^\d{8,15}$/.test(normalized))throw new Error("Invalid WhatsApp phone number");
  let rows:any[]=[];
  try{
    const response=await wa.onWhatsApp(normalized);
    rows=Array.isArray(response)?response:response?[response]:[];
  }catch(error){
    logger.warn({error:error instanceof Error?error.message:"lookup failed"},"WhatsApp number lookup failed");
  }
  const row=rows.find((item:any)=>item?.exists===true)??rows.find((item:any)=>item?.jid||item?.phoneNumber||item?.lid||item?.id);
  const exists=row?.exists===true;
  const candidates:string[]=[];
  const add=(value:any)=>{
    if(typeof value!=="string"||!value.trim())return;
    const raw=value.trim();
    if(/^\+?\d{8,15}$/.test(raw)){
      candidates.push(raw.replace(/\D/g,"")+"@s.whatsapp.net");
      return;
    }
    candidates.push(normalizeJid(raw));
  };
  add(row?.jid);add(row?.phoneNumber);add(row?.lid);add(row?.id);

  // WhatsApp may expose a LID instead of a PN JID. Resolve both identities
  // when Baileys has the mapping, and prefer the phone-number JID for writes.
  let mappingResolved=false;
  if(typeof wa.findUserId==="function"){
    const probes=[...candidates,normalized+"@s.whatsapp.net"];
    for(const probe of [...new Set(probes)]){
      try{
        const mapped=await wa.findUserId(probe);
        if(mapped?.phoneNumber){add(mapped.phoneNumber);mappingResolved=true;}
        if(mapped?.lid){add(mapped.lid);mappingResolved=true;}
      }catch(error){
        logger.debug({probe,error:error instanceof Error?error.message:"PN/LID mapping unavailable"},"Could not resolve WhatsApp participant PN/LID identity");
      }
    }
  }
  if(exists&&!candidates.length)add(normalized+"@s.whatsapp.net");
  const valid=[...new Set(candidates)].filter((jid)=>isPnJid(jid)||isLidJid(jid));
  const target=valid.find(isPnJid)||valid.find(isLidJid);
  if(!target||(!exists&&!mappingResolved)){
    throw new Error("O WhatsApp não confirmou que o número indicado está registado. Confirme o indicativo internacional e tente novamente.");
  }
  return {normalized,target};
}
async function participantJidForAddressingMode(wa:any,target:string,addressingMode:unknown){
  if(String(addressingMode??"").toLowerCase()!=="lid")return target;
  if(isLidJid(target))return target;
  if(typeof wa.findUserId!=="function")throw new Error("WhatsApp community uses LID addressing, but this Baileys session cannot resolve the participant LID");
  const mapped=await wa.findUserId(target);
  const lid=typeof mapped?.lid==="string"?normalizeJid(mapped.lid):"";
  if(!isLidJid(lid))throw new Error("WhatsApp community uses LID addressing, but the participant LID could not be resolved from the supplied phone number");
  return lid;
}
export async function resolveWhatsAppPhoneNumber(...identities:string[]):Promise<string|null>{
  const wa=requireSocket() as any;
  const aliases=await jidAliases(wa,...identities);
  const phoneJid=[...aliases].find(isPnJid);
  if(phoneJid)return phoneFromJid(phoneJid);
  for(const identity of identities){
    const value=String(identity||"").trim();
    if(!value.includes("@")){
      const digits=value.replace(/\D/g,"");
      if(/^\d{8,15}$/.test(digits))return digits;
    }
  }
  return null;
}
async function sameWhatsAppUser(wa:any,left:CommunityParticipant,rightJid:string){
  const leftAliases=await jidAliases(wa,left.id,left.phoneNumber,left.lid);
  const rightAliases=await jidAliases(wa,rightJid);
  return [...leftAliases].some(alias=>rightAliases.has(alias));
}
async function selfAliasesForSocket(wa:any){
  const selfJid=String(wa.user?.id??"");
  if(!selfJid)throw new Error("WhatsApp did not expose the connected account identity; permissions cannot be verified");
  const aliases=await jidAliases(wa,selfJid,String(wa.user?.lid??""),String(wa.user?.phoneNumber??""));
  if(aliases.size===0)throw new Error("Could not resolve the connected WhatsApp account identity; permissions cannot be verified");
  return aliases;
}
export async function isSelfOwner(owner:string|null|undefined,ownerPn:string|null|undefined=null):Promise<boolean>{
  const wa=requireSocket() as any;
  const selfAliases=await selfAliasesForSocket(wa);
  const ownerAliases=await jidAliases(wa,owner,ownerPn);
  return [...ownerAliases].some(alias=>selfAliases.has(alias));
}
export async function isSelfAdmin(participants:CommunityParticipant[],owner:string|null|undefined=null,ownerPn:string|null|undefined=null):Promise<boolean|null>{
  const wa=requireSocket() as any;
  const selfAliases=await selfAliasesForSocket(wa);
  // WhatsApp exposes the community creator separately as GroupMetadata.owner
  // (and, on PN/LID accounts, ownerPn). The owner has community-level authority
  // even when the participant row omits admin/superadmin or uses another JID form.
  const ownerAliases=await jidAliases(wa,owner,ownerPn);
  if([...ownerAliases].some(alias=>selfAliases.has(alias)))return true;
  const selfJid=String(wa.user?.id??"");
  const selfIsLid=isLidJid(normalizeJid(selfJid));
  const selfHasPn=[...selfAliases].some(isPnJid);
  let selfFound=false;
  let unresolvedParticipantIdentity=false;
  for(const participant of participants){
    const participantId=normalizeJid(participant.id);
    const participantAliases=await jidAliases(wa,participant.id,participant.phoneNumber,participant.lid);
    if([...participantAliases].some(alias=>selfAliases.has(alias))){
      selfFound=true;
      if(participant.admin==="admin"||participant.admin==="superadmin"||participant.isAdmin===true||participant.isSuperAdmin===true)return true;
      continue;
    }
    const participantHasPn=[...participantAliases].some(isPnJid);
    const participantHasLid=[...participantAliases].some(isLidJid);
    if(isLidJid(participantId)&&!participantHasPn)unresolvedParticipantIdentity=true;
    if(selfIsLid&&!selfHasPn&&isPnJid(participantId)&&!participantHasLid)unresolvedParticipantIdentity=true;
  }
  if(selfFound)return false;
  if(unresolvedParticipantIdentity||participants.length===0)return null;
  return false;
}
async function communityQuery(jid:string,type:"get"|"set",content:any[]){
  const wa=requireSocket() as any;
  if(typeof wa.query!=="function")throw new Error("This Baileys build does not expose the required WhatsApp community protocol query");
  return wa.query({tag:"iq",attrs:{type,xmlns:"w:g2",to:jid},content});
}
function normalizeCommunityMetadata(metadata:any,jid:string):CommunityMetadata{
  if(!metadata||typeof metadata!=="object")throw new Error("WhatsApp returned an empty community metadata response");
  const returnedId=normalizeJid(String(metadata.id??jid));
  if(returnedId!==normalizeJid(jid))throw new Error("WhatsApp returned metadata for a different group than the configured COMMUNITY_JID");
  if(metadata.isCommunity!==true)throw new Error("Configured COMMUNITY_JID was returned as a group, not as a WhatsApp community");
  if(!Array.isArray(metadata.participants))throw new Error("WhatsApp community metadata did not include a verifiable participants list");
  return {
    id:returnedId,
    subject:String(metadata.subject??""),
    isCommunity:true,
    addressingMode:String(metadata.addressingMode??"pn").toLowerCase(),
    owner:metadata.owner?String(metadata.owner):null,
    ownerPn:metadata.ownerPn?String(metadata.ownerPn):null,
    participants:metadata.participants.map((p:any)=>({
      id:String(p.id??p.jid??""),
      admin:p.admin??null,
      phoneNumber:p.phoneNumber?String(p.phoneNumber):null,
      lid:p.lid?String(p.lid):null,
      isAdmin:p.isAdmin===true,
      isSuperAdmin:p.isSuperAdmin===true,
    })).filter((p:CommunityParticipant)=>Boolean(p.id))
  };
}
type CommunitySnapshot={groups:any[];exact:any|null;communityCandidates:any[];linkedChildren:any[];communityFetchCount:number;communityFetchError:string|null;groupFetchError?:string|null};
let communitySnapshotCache:{socket:any;fetchedAt:number;snapshot:CommunitySnapshot}|null=null;
let communitySnapshotInFlight:Promise<CommunitySnapshot>|null=null;
let communitySnapshotCooldownUntil=0;
let communitySnapshotCooldownMs=60_000;
const profilePictureCache=new Map<string,{url:string|null;expiresAt:number}>();
const profilePictureInFlight=new Map<string,Promise<string|null>>();
function isRateLimitError(error:unknown){const message=error instanceof Error?error.message:String(error??"");return /rate[-_ ]?overlimit|rate.?limit|too many requests|http.?429/i.test(message);}
async function cachedProfilePictureUrl(wa:any,jid:string):Promise<string|null>{const key=normalizeJid(jid);const cached=profilePictureCache.get(key);if(cached&&cached.expiresAt>Date.now())return cached.url;const pending=profilePictureInFlight.get(key);if(pending)return pending;const task=Promise.resolve().then(()=>wa.profilePictureUrl(jid,"image")).then((url:any)=>typeof url==="string"?url:null).catch(()=>null).then((url)=>{profilePictureCache.set(key,{url,expiresAt:Date.now()+10*60*1000});return url;}).finally(()=>profilePictureInFlight.delete(key));profilePictureInFlight.set(key,task);return task;}
async function fetchCommunitySnapshot(wa:any,jid:string):Promise<CommunitySnapshot>{
  const now=Date.now();const cached=communitySnapshotCache?.socket===wa?communitySnapshotCache:null;
  if(cached&&now-cached.fetchedAt<45_000)return cached.snapshot;
  if(communitySnapshotInFlight)return communitySnapshotInFlight;
  if(now<communitySnapshotCooldownUntil){if(cached)return cached.snapshot;throw new Error("rate-overlimit: WhatsApp is temporarily limiting participating-groups queries; retry after the cooldown");}
  const task=(async()=>{
    const byId=new Map<string,any>();let communityFetchError:string|null=null;let groupFetchError:string|null=null;let communityFetchCount=0;
    if(typeof wa.communityFetchAllParticipating==="function"){
      try{const communities=await wa.communityFetchAllParticipating();const items=Object.values(communities||{}) as any[];communityFetchCount=items.filter((item:any)=>item?.isCommunity===true).length;for(const item of items){if(item?.id)byId.set(normalizeJid(String(item.id)),item);}}
      catch(error){communityFetchError=error instanceof Error?error.message:String(error);logger.warn({error:communityFetchError},"Baileys communityFetchAllParticipating failed");
        // A rate limit on the dedicated Community query must not prevent the
        // general participating-groups query from supplying the same root and
        // linked announcement group metadata.
      }
    }
    try{const fetched=await wa.groupFetchAllParticipating();for(const item of Object.values(fetched||{}) as any[]){if(item?.id){const id=normalizeJid(String(item.id));byId.set(id,{...(byId.get(id)||{}),...item});}}}
    catch(error){groupFetchError=error instanceof Error?error.message:String(error);logger.warn({error:groupFetchError,communityFetchCount},"Baileys groupFetchAllParticipating failed");if(byId.size===0)throw error;}
    const groups=[...byId.values()];const normalized=normalizeJid(jid);
    const snapshot:CommunitySnapshot={groups,exact:groups.find((item:any)=>normalizeJid(String(item.id))===normalized)??null,communityCandidates:groups.filter((item:any)=>item.isCommunity===true),linkedChildren:groups.filter((item:any)=>normalizeJid(String(item.linkedParent||""))===normalized),communityFetchCount,communityFetchError,groupFetchError};
    communitySnapshotCache={socket:wa,fetchedAt:Date.now(),snapshot};communitySnapshotCooldownUntil=0;communitySnapshotCooldownMs=60_000;return snapshot;
  })();
  communitySnapshotInFlight=task;
  try{return await task;}catch(error){if(isRateLimitError(error)){const cooldown=communitySnapshotCooldownMs;communitySnapshotCooldownUntil=Date.now()+cooldown;communitySnapshotCooldownMs=Math.min(cooldown*2,30*60_000);if(cached)return cached.snapshot;}throw error;}finally{communitySnapshotInFlight=null;}
}
function metadataFailure(error:unknown){
  const statusCode=(error as any)?.output?.statusCode??(error as any)?.statusCode??null;
  const message=error instanceof Error?error.message:String(error??"unknown error");
  return {statusCode,message};
}
export async function getCommunity(jid:string):Promise<CommunityMetadata>{
  const wa=requireSocket() as any;
  const configuredId=normalizeJid(jid);
  let snapshot:CommunitySnapshot|null=null;
  let snapshotError:unknown=null;
  // Fetch the authenticated participating-groups snapshot first. It is often
  // the only response that contains the root community on linked-device sessions.
  try{snapshot=await fetchCommunitySnapshot(wa,configuredId);}
  catch(error){snapshotError=error;}
  if(snapshotError&&isRateLimitError(snapshotError)){logger.warn({configuredJid:configuredId,error:metadataFailure(snapshotError)},"Skipping direct community metadata query during WhatsApp rate-limit cooldown");throw new Error("WhatsApp community discovery is temporarily rate-limited. The session remains connected; retry after the cooldown. "+(snapshotError instanceof Error?snapshotError.message:""));}
  // Exact configured id in the participating snapshot is authoritative.
  if(snapshot?.exact?.isCommunity===true){
    try{return normalizeCommunityMetadata(snapshot.exact,configuredId);}
    catch(error){logger.warn({jid:configuredId,error:metadataFailure(error)},"Configured community snapshot could not be normalized");}
  }
  let directError:unknown=null;
  let directMetadata:any=null;
  try{
    if(typeof wa.groupMetadata!=="function")throw new Error("This Baileys build does not expose groupMetadata");
    directMetadata=await wa.groupMetadata(configuredId);
    if(directMetadata?.isCommunity===true)return normalizeCommunityMetadata(directMetadata,configuredId);
    // A stale COMMUNITY_JID may point to a subgroup. Baileys exposes its root
    // community in linkedParent; resolve that id instead of treating the
    // subgroup as the platform's main community.
    const parent=normalizeJid(String(directMetadata?.linkedParent||""));
    if(parent){
      const parentSnapshot=snapshot?.groups.find((item:any)=>normalizeJid(String(item.id))===parent);
      if(parentSnapshot?.isCommunity===true)return normalizeCommunityMetadata(parentSnapshot,parent);
      try{
        const parentMetadata=await wa.groupMetadata(parent);
        if(parentMetadata?.isCommunity===true)return normalizeCommunityMetadata(parentMetadata,parent);
      }catch(parentError){
        logger.warn({configuredJid:configuredId,parentJid:parent,error:metadataFailure(parentError)},"Could not fetch linked parent community metadata");
      }
    }
    directError=new Error("Configured COMMUNITY_JID resolved to a WhatsApp group, not the community root"+(parent?" (linked parent "+parent+")":""));
  }catch(error){directError=error;}
  // If the configured id is absent from the snapshot but WhatsApp returned
  // exactly one community, use that authenticated, unambiguous community.
  // Never choose arbitrarily when the linked account belongs to multiple communities.
  if(snapshot?.communityCandidates.length===1){
    const candidate=snapshot.communityCandidates[0];
    logger.warn({configuredJid:configuredId,resolvedCommunityJid:normalizeJid(String(candidate.id)),snapshotGroupCount:snapshot.groups.length},"Configured community id did not match; using the only participating WhatsApp community");
    return normalizeCommunityMetadata(candidate,String(candidate.id));
  }
  // If there are several candidates, the linked groups can still reveal a
  // unique parent for the configured child group.
  if(snapshot?.exact?.linkedParent){
    const parent=normalizeJid(String(snapshot.exact.linkedParent));
    const candidate=snapshot.communityCandidates.find((item:any)=>normalizeJid(String(item.id))===parent);
    if(candidate)return normalizeCommunityMetadata(candidate,parent);
  }
  const candidates=snapshot?.communityCandidates.map((item:any)=>({
    id:normalizeJid(String(item.id)),
    subject:String(item.subject||""),
    linkedParent:normalizeJid(String(item.linkedParent||""))||null,
  }))??[];
  logger.error({
    configuredJid:configuredId,
    snapshotGroupCount:snapshot?.groups.length??null,
    exactSnapshotFound:Boolean(snapshot?.exact),
    exactSnapshotIsCommunity:snapshot?.exact?.isCommunity??null,
    exactSnapshotLinkedParent:snapshot?.exact?.linkedParent??null,
    communityCandidates:candidates,
    linkedChildrenCount:snapshot?.linkedChildren.length??0,
    directError:metadataFailure(directError),
    snapshotError:snapshotError?metadataFailure(snapshotError):null,
  },"Unable to resolve configured WhatsApp community metadata");
  const statusCode=(directError as any)?.output?.statusCode??(directError as any)?.statusCode;
  const detail=directError instanceof Error?directError.message:"WhatsApp metadata query failed";
  const snapshotDetail=snapshotError instanceof Error?"; participating groups query: "+snapshotError.message:"";
  throw new Error("Could not resolve WhatsApp community metadata for "+configuredId+(statusCode?" (WhatsApp HTTP "+statusCode+")":"")+": "+detail+snapshotDetail+"; found "+candidates.length+" community candidate(s)");
}
export async function inspectCommunityDiscovery(jid:string){
  const wa=requireSocket() as any;
  let snapshot:CommunitySnapshot|null=null;let snapshotError:string|null=null;
  try{snapshot=await fetchCommunitySnapshot(wa,jid);}catch(error){snapshotError=error instanceof Error?error.message:String(error);}
  return {
    configuredJid:normalizeJid(jid),
    connectedJid:normalizeJid(String(wa.user?.id??""))||null,
    groupCount:snapshot?.groups.length??null,
    communityFetchCount:snapshot?.communityFetchCount??null,
    communityFetchError:snapshot?.communityFetchError??null,
    groupFetchError:snapshot?.groupFetchError??snapshotError,
    snapshotError,
    exactMatch:snapshot?.exact?{
      id:normalizeJid(String(snapshot.exact.id)),
      subject:String(snapshot.exact.subject||""),
      isCommunity:snapshot.exact.isCommunity===true,
      linkedParent:normalizeJid(String(snapshot.exact.linkedParent||""))||null,
      participantCount:Array.isArray(snapshot.exact.participants)?snapshot.exact.participants.length:null,
    }:null,
    communities:(snapshot?.communityCandidates??[]).map((item:any)=>({
      id:normalizeJid(String(item.id)),
      subject:String(item.subject||""),
      participantCount:Array.isArray(item.participants)?item.participants.length:null,
    })),
    linkedChildren:(snapshot?.linkedChildren??[]).map((item:any)=>({
      id:normalizeJid(String(item.id)),
      subject:String(item.subject||""),
      linkedParent:normalizeJid(String(item.linkedParent||"")),
    })),
    methods:{
      groupMetadata:typeof wa.groupMetadata==="function",
      groupFetchAllParticipating:typeof wa.groupFetchAllParticipating==="function",
      communityMetadata:typeof wa.communityMetadata==="function",
      communityFetchAllParticipating:typeof wa.communityFetchAllParticipating==="function",
      communityParticipantsUpdate:typeof wa.communityParticipantsUpdate==="function",
    },
  };
}
// ---------------------------------------------------------------------------
// Community entry. WhatsApp rejects direct "add" requests sent to a Community
// root with `bad-request`. The WhatsApp app adds Community members through the
// Community announcements group (default_sub_group); a participant added there
// becomes a member of the Community automatically. When the participant's
// privacy settings block direct adds (403) or they recently left (408),
// WhatsApp expects an invite to be sent instead, exactly like the official app.
// ---------------------------------------------------------------------------
type AddOutcome={phone:string;action:"add";status:"added_verified"|"request_submitted"|"already_member"|"invite_sent";jid:string;whatsappStatus?:string;inviteMethod?:string};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function optionalLidFor(wa:any,target:string):Promise<string|null>{
  if(isLidJid(target))return target;
  try{
    const mapping=wa?.signalRepository?.lidMapping;
    if(typeof mapping?.getLIDForPN==="function"){
      const lid=await mapping.getLIDForPN(target);
      if(typeof lid==="string"&&isLidJid(normalizeJid(lid)))return normalizeJid(lid);
    }
  }catch{}
  try{
    if(typeof wa.findUserId==="function"){
      const mapped=await wa.findUserId(target);
      const lid=typeof mapped?.lid==="string"?normalizeJid(mapped.lid):"";
      if(isLidJid(lid))return lid;
    }
  }catch{}
  return null;
}
async function findAnnouncementGroup(wa:any,communityJid:string):Promise<{jid:string;subject:string}|null>{
  const root=normalizeJid(communityJid);
  // Discovery errors must propagate. Returning null on rate limiting used to
  // trigger an unsafe fallback that attempted to add directly to the root.
  const snapshot=await fetchCommunitySnapshot(wa,root);
  const children=snapshot.groups.filter((item:any)=>normalizeJid(String(item?.linkedParent||""))===root);
  const flagged=children.find((item:any)=>item?.isCommunityAnnounce===true);
  if(flagged)return {jid:normalizeJid(String(flagged.id)),subject:String(flagged.subject||"")};
  for(const child of children){
    try{
      const meta=await wa.groupMetadata(String(child.id));
      if(meta?.isCommunityAnnounce===true)return {jid:normalizeJid(String(meta.id)),subject:String(meta.subject||"")};
    }catch(error){
      logger.warn({groupJid:String(child.id),error:error instanceof Error?error.message:String(error)},"Could not read linked group metadata");
    }
  }
  return null;
}
async function groupHasParticipant(wa:any,groupJid:string,target:string){
  const meta:any=await wa.groupMetadata(groupJid).catch(()=>null);
  for(const participant of (Array.isArray(meta?.participants)?meta.participants:[])){
    if(await sameWhatsAppUser(wa,{id:String(participant.id||""),phoneNumber:participant.phoneNumber,lid:participant.lid},target))return true;
  }
  return false;
}
export async function isParticipantInGroup(groupJid:string,phone:string):Promise<string|null>{
  const wa=requireSocket() as any;
  const normalized=String(phone||"").replace(/\D/g,"");
  const target=normalized+"@s.whatsapp.net";
  const jid=normalizeJid(groupJid);
  try{
    const community=await getCommunity(jid);
    if(normalizeJid(community.id)===jid){
      for(const participant of community.participants){
        if(await sameWhatsAppUser(wa,participant,target))return target;
      }
      return null;
    }
  }catch{}
  return (await groupHasParticipant(wa,jid,target))?target:null;
}
async function sendJoinInvite(wa:any,normalized:string,groupJid:string,groupName:string,inviteJid:string,addRequest:any){
  const recipient=normalized+"@s.whatsapp.net";
  const caption="Olá! A sua inscrição na Encontre + foi aprovada. As definições de privacidade do seu WhatsApp não permitem que o adicionemos automaticamente. Toque no convite para entrar na Comunidade "+(groupName||"Encontre +")+".";
  const code=addRequest?.attrs?.code?String(addRequest.attrs.code):"";
  const expiration=Number(addRequest?.attrs?.expiration||0);
  if(code){
    try{
      await wa.sendMessage(recipient,{groupInvite:{jid:groupJid,inviteCode:code,inviteExpiration:expiration||Math.floor(Date.now()/1000)+3*86400,subject:groupName||"Encontre +",text:caption}});
      return "group_invite_message";
    }catch(error){
      logger.warn({error:error instanceof Error?error.message:String(error)},"Native WhatsApp group invite message failed; falling back to invite link");
    }
  }
  let link="";
  for(const jid of [inviteJid,groupJid]){
    try{const inviteCode=await wa.groupInviteCode(jid);if(inviteCode){link="https://chat.whatsapp.com/"+inviteCode;break;}}catch{}
  }
  if(!link)throw new Error("O WhatsApp bloqueou a adição directa e não foi possível gerar um convite para este número");
  await wa.sendMessage(recipient,{text:caption+"\n\n"+link});
  return "invite_link_message";
}
async function addToGroupWithFallback(wa:any,opts:{groupJid:string;groupName:string;inviteJid:string},normalized:string,target:string):Promise<AddOutcome>{
  const candidates=[target];
  const lid=await optionalLidFor(wa,target);
  if(lid&&!candidates.includes(lid))candidates.push(lid);
  let update:any=null;let usedJid=target;let lastError:unknown=null;
  for(const candidate of candidates){
    const isLast=candidate===candidates[candidates.length-1];
    try{
      const response=await wa.groupParticipantsUpdate(opts.groupJid,[candidate],"add");
      update=Array.isArray(response)?response[0]:null;
      usedJid=candidate;
      const st=String(update?.status??"");
      if((st==="400"||st==="bad-request")&&!isLast){update=null;continue;}
      break;
    }catch(error){
      lastError=error;
      const message=error instanceof Error?error.message:String(error);
      logger.warn({groupJid:opts.groupJid,candidateType:isLidJid(candidate)?"lid":"pn",error:message},"WhatsApp group add attempt failed");
      if(/bad-request/i.test(message)&&!isLast)continue;
      throw error;
    }
  }
  if(!update){
    if(lastError)throw lastError;
    throw new Error("WhatsApp returned no per-participant result; operation is not confirmed");
  }
  const waStatus=String(update.status??"200");
  logger.info({groupJid:opts.groupJid,waStatus,candidateType:isLidJid(usedJid)?"lid":"pn"},"WhatsApp group add result");
  if(waStatus==="200"||waStatus==="409"){
    for(let i=0;i<3;i++){
      if(await groupHasParticipant(wa,opts.groupJid,target))return {phone:normalized,action:"add",status:waStatus==="409"?"already_member":"added_verified",jid:target,whatsappStatus:waStatus};
      await sleep(1500);
    }
    if(waStatus==="200")return {phone:normalized,action:"add",status:"request_submitted",jid:target,whatsappStatus:waStatus};
  }
  if(waStatus==="403"||waStatus==="408"){
    const addRequest=findNode(update.content,"add_request");
    const inviteMethod=await sendJoinInvite(wa,normalized,opts.groupJid,opts.groupName,opts.inviteJid,addRequest);
    return {phone:normalized,action:"add",status:"invite_sent",jid:target,whatsappStatus:waStatus,inviteMethod};
  }
  if(waStatus==="401")throw new Error("Este número bloqueou a conta WhatsApp da Encontre + (status 401)");
  throw new Error("WhatsApp did not accept the group participant operation (status "+waStatus+")");
}

export async function participantAction(jid:string,phone:string,action:"add"|"remove"){
  const wa=requireSocket() as any;
  const meta=await getCommunity(jid);
  const admin=await isSelfAdmin(meta.participants,meta.owner,meta.ownerPn);
  if(admin===null)throw new Error("The connected WhatsApp account's administrator permissions could not be verified because a PN/LID identity mapping is missing");
  if(!admin)throw new Error("The connected WhatsApp account is not an administrator of the configured community");
  const {normalized,target}=await resolveWhatsAppParticipant(wa,phone);
  if(action==="remove" && await sameWhatsAppUser(wa,{id:String(wa.user?.id??"")},target)) throw new Error("The connected administrator account cannot remove itself from its community");
  if(action==="remove"){
    const ownerAliases=await jidAliases(wa,meta.owner,meta.ownerPn);
    const targetAliases=await jidAliases(wa,target);
    if([...ownerAliases].some(alias=>targetAliases.has(alias)))throw new Error("Refusing to remove the WhatsApp community owner");
  }
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
  const communityJid=meta.id;
  if(action==="add"){
    const announcement=await findAnnouncementGroup(wa,communityJid);
    if(!announcement){
      throw new Error("Community announcements group could not be identified; refusing to add directly to the Community root");
    }
    const outcome=await addToGroupWithFallback(wa,{groupJid:announcement.jid,groupName:meta.subject,inviteJid:communityJid},normalized,target);
    return {...outcome,communityJid,announcementJid:announcement.jid};
  }
  const writeTarget=await participantJidForAddressingMode(wa,target,meta.addressingMode);
  let waStatus="200";
  try {
    if(typeof wa.communityParticipantsUpdate==="function"){
      const updates=await wa.communityParticipantsUpdate(communityJid,[writeTarget],action);
      const update=Array.isArray(updates)?updates.find((item:any)=>normalizeJid(String(item.jid||""))===normalizeJid(target))??updates[0]:null;
      if(!update)throw new Error("WhatsApp returned no per-participant result; operation is not confirmed");
      waStatus=String(update.status??"200");
    }else{
      const response=await communityQuery(communityJid,"set",[
        {
          tag:action,
          attrs:action==="remove"?{linked_groups:"true"}:{},
          content:[{tag:"participant",attrs:{jid:writeTarget}}]
        }
      ]);
      const resultNode=findNode(response,action);
      const participant=findNodes(resultNode,"participant").find((p:any)=>p.attrs?.jid===target);
      if(!participant)throw new Error("WhatsApp returned no per-participant result; operation is not confirmed");
      waStatus=String(participant.attrs?.error??"200");
    }
  } catch(error) {
    const failure=error as any;
    logger.error({
      action,
      communityJid,
      errorName:failure?.name??null,
      errorMessage:failure?.message??String(error),
      statusCode:failure?.output?.statusCode??failure?.statusCode??null,
      outputPayload:failure?.output?.payload??null,
      stack:failure?.stack??null,
    },"WhatsApp community participant update failed");
    throw error;
  }
  if(waStatus!=="200")throw new Error("WhatsApp rejected the community "+action+" operation (status "+waStatus+")");
  return {phone:normalized,action,status:"request_submitted",jid:target,communityJid,whatsappStatus:waStatus,removesFromLinkedGroups:true};
}

export async function listCommunities(configuredJid:string){
  const wa=requireSocket() as any;
  const snapshot=await fetchCommunitySnapshot(wa,configuredJid);
  const groups=snapshot.groups;
  const configuredId=normalizeJid(configuredJid);
  const byId=new Map(groups.filter(g=>g?.id).map(g=>[normalizeJid(String(g.id)),g]));
  let resolvedConfigured:CommunityMetadata|null=null;
  if(configuredId){
    try{
      resolvedConfigured=await getCommunity(configuredId);
      byId.set(resolvedConfigured.id,resolvedConfigured);
    }catch(error){
      logger.warn({jid:configuredId,error:error instanceof Error?error.message:String(error)},"Could not resolve configured WhatsApp community from participating groups");
    }
  }
  const communityGroups=[...byId.values()].filter(g=>g?.isCommunity===true);
  const result=[];
  for(const group of communityGroups){
    const id=normalizeJid(String(group.id));
    let meta:any=group;
    let metadataSource:"live"|"participating_cache"="participating_cache";
    let adminStatus:"admin"|"not_admin"|"unknown"="unknown";
    let adminCheckError:string|null=null;
    if(resolvedConfigured&&id===resolvedConfigured.id){
      meta={...group,...resolvedConfigured};
      metadataSource="live";
    }
    if(!adminCheckError&&Array.isArray(meta.participants)){
      try{const isAdmin=await isSelfAdmin(meta.participants,meta.owner,meta.ownerPn);adminStatus=isAdmin===null?"unknown":isAdmin?"admin":"not_admin";}
      catch(error){adminCheckError=error instanceof Error?error.message:"Administrator permissions could not be verified";}
    }else if(!adminCheckError){
      adminCheckError="WhatsApp did not return a participants list for this community";
    }
    const isAdmin=adminStatus==="admin"?true:adminStatus==="not_admin"?false:null;
    const isOwner=adminStatus==="admin"?await isSelfOwner(meta.owner,meta.ownerPn).catch(()=>false):false;
    const subgroups=groups.filter(g=>normalizeJid(String(g.linkedParent||""))===id);
    const profile=await cachedProfilePictureUrl(wa,id);
    const childrenWithPictures=[];
    for(const childGroup of subgroups){
      const childPicture=await cachedProfilePictureUrl(wa,String(childGroup.id));
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
      account_role:isOwner?"owner":adminStatus==="admin"?"admin":adminStatus==="not_admin"?"member":"unknown",
      isOwner,
      metadata_source:metadataSource,
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
  const ownerAliases=await jidAliases(wa,metadata.owner,metadata.ownerPn);
  const result=[];
  for(const p of participants){
    const id=String(p.id||p.jid||"");
    const aliases=await jidAliases(wa,id,p.phoneNumber,p.lid);
    const phoneJid=[...aliases].find(isPnJid)||null;
    const phoneNumber=phoneJid?phoneFromJid(phoneJid):null;
    const isOwner=[...aliases].some(alias=>ownerAliases.has(alias));
    const isAdmin=isOwner||p.admin==="admin"||p.admin==="superadmin"||p.isAdmin===true||p.isSuperAdmin===true;
    result.push({
      id,
      // Expose the canonical PN JID when available. Downstream membership
      // reconciliation must never mistake a numeric LID for a phone number.
      jid:phoneJid||id,
      phoneNumber,
      admin:Boolean(isAdmin),
      role:isOwner?"owner":isAdmin?"admin":"member",
      isOwner,
      name:p.name?String(p.name):null,
    });
  }
  return result;
}

export async function groupParticipantAction(jid:string,phone:string,action:"add"|"remove",configuredJid:string){
  const wa=requireSocket() as any;
  const normalizedJid=normalizeJid(jid);
  // Resolve the actual community root independently of a possibly stale
  // COMMUNITY_JID environment value. A subgroup resolves to its parent, so
  // only an exact id match is treated as a community-level operation.
  try{
    const resolvedCommunity=await getCommunity(normalizedJid);
    if(normalizeJid(resolvedCommunity.id)===normalizedJid){
      return participantAction(normalizedJid,phone,action);
    }
  }catch(error){
    logger.debug({jid:normalizedJid,error:error instanceof Error?error.message:"community metadata unavailable"},"JID did not resolve as a community root; checking regular group metadata");
  }
  const metadata:any=await wa.groupMetadata(normalizedJid);
  if(metadata.isCommunity)return participantAction(normalizedJid,phone,action);
  const selfIsAdmin=await isSelfAdmin(Array.isArray(metadata.participants)?metadata.participants:[],metadata.owner,metadata.ownerPn);
  if(selfIsAdmin===null)throw new Error("The connected WhatsApp account's administrator permissions could not be verified because a PN/LID identity mapping is missing");
  if(!selfIsAdmin){
    throw new Error("The connected WhatsApp account is not an administrator of this group");
  }
  const {normalized,target}=await resolveWhatsAppParticipant(wa,phone);
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
  if(action==="add"){
    return addToGroupWithFallback(wa,{groupJid:normalizedJid,groupName:String(metadata.subject||""),inviteJid:normalizedJid},normalized,target);
  }
  const writeTarget=await participantJidForAddressingMode(wa,target,metadata.addressingMode);
  const response=await wa.groupParticipantsUpdate(normalizedJid,[writeTarget],action);
  const result=Array.isArray(response)?response[0]:null;
  const resultStatus=String(result?.status||"200");
  if(!result||resultStatus!=="200")throw new Error("WhatsApp did not accept the group participant operation (status "+resultStatus+")");
  return {phone:normalized,action,status:"request_submitted",jid:target,whatsappStatus:resultStatus};
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
