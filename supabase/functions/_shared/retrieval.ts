import { CONFIG, type SensitivityClass } from "./config.ts";
import { embedQuery } from "./gemini.ts";
import type { InputMode } from "./os.ts";

export type RetrievalDepth = "fast" | "normal" | "deep";
export type ResolvedEntity = { id:string; entity_type:string; canonical_name:string; normalized_key:string; aliases:string[]; domains:string[]; match:string };
export type RetrievalPlan = {
  depth:RetrievalDepth; domainHints:string[]; requiredDomains:string[]; strictDomain:boolean;
  broadProfile:boolean; broadContext:boolean; currentStateRelevant:boolean; retrievalQuery:string;
  recordLimit:number; chunkLimit:number; profileLimit:number;
};

export function normalized(text:string):string{return text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu,"").replace(/[^\p{L}\p{N}]+/gu," ").replace(/\s+/g," ").trim();}
function padded(text:string){return ` ${normalized(text)} `;}
function hasPhrase(text:string, phrase:string){const p=normalized(phrase);return p.length>1&&padded(text).includes(` ${p} `);}
function anyPhrase(text:string, phrases:string[]){return phrases.some(p=>hasPhrase(text,p));}

export function detectQueryDomains(text:string):string[]{
  const domains=new Set<string>();
  const dating=["dating","romantic","romance","flirt","date","dates","dating history","ραντεβου","κοπελα","κοπελες","φλερτ","ερωτικα","ερωτικη","ερωτικο"];
  const relationship=["relationship","relationships","σχεση","σχεσεις","πατερας","πατερα","father","family","οικογενεια"];
  if(anyPhrase(text,dating)){domains.add("dating");domains.add("relationships");}
  if(anyPhrase(text,relationship))domains.add("relationships");
  if(anyPhrase(text,["career","job","work","δουλεια","εργασια","καριερα","ρολος","ρολο",...CONFIG.careerAliases])){domains.add("career");domains.add("work");}
  if(anyPhrase(text,["learning","learn","sql","python","typescript","git","testing","swe","μαθηση","δεξιοτητα","δεξιοτητες","τεχνικη","τεχνικο"])){domains.add("learning");}
  if(anyPhrase(text,["university","exam","exams","course","πανεπιστημιο","σχολη","εξεταση","εξετασεις","μαθημα"])){domains.add("university");}
  if(anyPhrase(text,["health","medical","doctor","cardiology","υγεια","γιατρος","γιατρο","εξετασεις αιματος"])){domains.add("health");}
  if(anyPhrase(text,["fitness","gym","running","marathon","long run","training plan","γυμναστηριο","τρεξιμο","μαραθωνιος","προπονηση"])){domains.add("fitness");}
  if(anyPhrase(text,["finance","financial","money","salary","budget","reo co","reoco","οικονομικα","χρηματα","μισθος","σπιτι"])){domains.add("finance");}
  if(anyPhrase(text,["personal os","supabase","telegram bot","retrieval","router","webhook","pgvector","edge function","model routing"])){domains.add("system");domains.add("personal_os");}
  return [...domains];
}

function requiredDomainsFor(text:string, domains:string[]):string[]{
  if(anyPhrase(text,["dating","dating history","romantic","romance","flirt","ραντεβου","κοπελα","κοπελες","φλερτ","ερωτικα"]))return["dating"];
  if(domains.includes("health")&&!domains.includes("fitness"))return["health"];
  if(domains.includes("fitness")&&!domains.includes("health"))return["fitness"];
  if(domains.includes("university"))return["university"];
  if(domains.includes("finance"))return["finance"];
  if(domains.includes("system"))return["system","personal_os"];
  if(domains.includes("career")||domains.includes("work"))return["career","work"];
  return[];
}

export function isBroadProfileQuery(text:string):boolean{return ["τι ξερεις για μενα","τι θυμασαι για μενα","τι εχεις για μενα","ποιος ειμαι","what do you know about me","what do you remember about me","summarize what you know about me"].some(s=>normalized(text).includes(normalized(s)));}
export function wantsBroadContext(text:string):boolean{return isBroadProfileQuery(text)||["με βαση ολα οσα ξερεις","με βαση οσα ξερεις","ολη την ιστορια μου","ολο το ιστορικο","ολα τα δεδομενα","συνολικα για μενα","across everything you know","based on everything you know","whole history","deep retrieval"].some(s=>normalized(text).includes(normalized(s)));}
export function shouldIncludeCurrentState(text:string,domains:string[],broad:boolean):boolean{const explicit=anyPhrase(text,["προτεραιοτητες","αυτη την περιοδο","τωρα","σημερα","current state","current priorities","current situation","στοχοι μου","πλανο μου","bottleneck"]);if(explicit)return true;if(broad)return false;const eligible=new Set(["career","work","learning","university","productivity","system","personal_os"]);return domains.some(d=>eligible.has(d));}

function expandQuery(text:string,domains:string[]){const a:string[]=[];if(domains.includes("dating"))a.push("dating romantic relationship ραντεβού κοπέλα φλερτ");else if(domains.includes("relationships"))a.push("relationship relationships σχέση σχέσεις family father πατέρας");if(domains.includes("career")||domains.includes("work"))a.push(["career","work","job","role","δουλειά","εργασία","καριέρα",...CONFIG.careerAliases].join(" "));if(domains.includes("learning"))a.push("learning skill technical swe μάθηση δεξιότητα");if(domains.includes("university"))a.push("university exam course πανεπιστήμιο εξέταση μάθημα");if(domains.includes("health"))a.push("health medical υγεία");if(domains.includes("fitness"))a.push("fitness training running marathon προπόνηση");if(domains.includes("finance"))a.push("finance money salary budget οικονομικά");if(domains.includes("system"))a.push("personal os retrieval router database telegram supabase");return[text.trim(),...a].filter(Boolean).join(" | ");}

function domainGroupCount(domains:string[]):number{
  const groups=[
    domains.some(d=>["dating","relationships"].includes(d)),
    domains.some(d=>["career","work"].includes(d)),
    domains.includes("learning"),domains.includes("university"),domains.includes("health"),domains.includes("fitness"),domains.includes("finance"),
    domains.some(d=>["system","personal_os"].includes(d)),
  ];
  return groups.filter(Boolean).length;
}
function retrievalFacets(domains:string[]):string[][]{
  const facets:string[][]=[];
  if(domains.includes("dating"))facets.push(["dating"]);
  else if(domains.includes("relationships"))facets.push(["relationships"]);
  if(domains.some(d=>["career","work"].includes(d)))facets.push(["career","work"]);
  for(const domain of ["learning","university","health","fitness","finance"]){if(domains.includes(domain))facets.push([domain]);}
  if(domains.some(d=>["system","personal_os"].includes(d)))facets.push(["system","personal_os"]);
  return facets;
}

export function buildRetrievalPlan(text:string,mode:InputMode,thinkingLevel:string):RetrievalPlan{
  const domainHints=detectQueryDomains(text),broadProfile=isBroadProfileQuery(text),broadContext=wantsBroadContext(text);
  const requiredDomains=requiredDomainsFor(text,domainHints);
  const strictDomain=requiredDomains.length>0&&!broadContext&&domainGroupCount(domainHints)<=1;
  const depth:RetrievalDepth=mode==="deep"||thinkingLevel==="HIGH"?"deep":mode==="fast"?"fast":"normal";
  return{depth,domainHints,requiredDomains,strictDomain,broadProfile,broadContext,currentStateRelevant:shouldIncludeCurrentState(text,domainHints,broadContext),retrievalQuery:expandQuery(text,domainHints),recordLimit:depth==="deep"?CONFIG.deepRecordRetrievalLimit:depth==="fast"?Math.min(10,CONFIG.recordRetrievalLimit):CONFIG.recordRetrievalLimit,chunkLimit:mode==="capture"?2:depth==="deep"?CONFIG.deepChunkRetrievalLimit:depth==="fast"?Math.min(3,CONFIG.chunkRetrievalLimit):CONFIG.chunkRetrievalLimit,profileLimit:CONFIG.profileRetrievalLimit};
}

export function routeSensitivityHint(
  text:string,
  domains:string[],
  context?:{ recentMessages?:any[]; relevantRecords?:any[]; relevantChunks?:any[] },
):SensitivityClass{
  const n=normalized(text);
  if(/\b(password|passwd|api key|secret|token)\b/i.test(n))return"restricted";

  const recentSensitivities=(context?.recentMessages??[]).map((row:any)=>String(row?.sensitivity??""));
  const chunkSensitivities=(context?.relevantChunks??[]).map((row:any)=>String(row?.sensitivity??""));
  if([...recentSensitivities,...chunkSensitivities].includes("restricted"))return"restricted";
  if([...recentSensitivities,...chunkSensitivities].includes("work_confidential"))return"work_confidential";

  const contextDomains=new Set<string>(domains);
  for(const row of context?.relevantRecords??[])for(const domain of row?.domains??[])contextDomains.add(String(domain));
  for(const row of context?.relevantChunks??[])for(const domain of row?.domains??[])contextDomains.add(String(domain));

  const sensitiveDomains=["dating","relationships","health","finance","personal_growth"];
  if(
    chunkSensitivities.includes("personal_sensitive")
    || recentSensitivities.includes("personal_sensitive")
    || sensitiveDomains.some((domain)=>contextDomains.has(domain))
    || anyPhrase(text,["πατερας","father","ψυχολογια","mental health","medical"])
  )return"personal_sensitive";

  if(contextDomains.has("work")&&anyPhrase(text,["confidential","internal client","customer data","εμπιστευτικο","πελατη"]))return"work_confidential";
  if(contextDomains.has("work")||contextDomains.has("career"))return"work_safe";
  return"personal_safe";
}

async function resolveEntities(supabase:any,userId:string,text:string):Promise<ResolvedEntity[]>{
  try{const {data,error}=await supabase.from("memory_entities").select("id,entity_type,canonical_name,normalized_key,aliases,domains").eq("user_id",userId).eq("status","active").limit(250);if(error)throw error;const q=padded(text);const matches:ResolvedEntity[]=[];for(const e of data??[]){const aliases=[e.canonical_name,...(e.aliases??[])];let matched="";for(const alias of aliases){const n=normalized(alias);if(n.length>=2&&q.includes(` ${n} `)){matched=alias;break;}}if(matched)matches.push({...e,match:matched});}return matches.slice(0,12);}catch(e){console.error("entity resolution failed",e);return[];}
}
function dedupeById<T extends{id?:string}>(arrays:T[][]):T[]{const seen=new Set<string>(),out:T[]=[];for(const rows of arrays)for(const row of rows??[]){const id=String(row?.id??"");if(id&&seen.has(id))continue;if(id)seen.add(id);out.push(row);}return out;}

export async function fetchContext(args:{supabase:any;userId:string;conversationId:string;text:string;mode:InputMode;thinkingLevel:string;useSemantic?:boolean}){
  const plan=buildRetrievalPlan(args.text,args.mode,args.thinkingLevel);
  const recentResult=await args.supabase.from("messages").select("role,content,transcript,sensitivity,created_at").eq("conversation_id",args.conversationId).eq("processing_status","completed").not("role","eq","system").order("created_at",{ascending:false}).limit(plan.depth==="deep"?Math.max(CONFIG.recentMessageLimit,12):CONFIG.recentMessageLimit);if(recentResult.error)console.error("recent messages retrieval error",recentResult.error);const recentDesc=recentResult.data??[];
  const shortFollow=args.text.trim().length<36&&/^(και|αυτ|αυτη|αυτό|εκεί|τι γινε|what about|and )/i.test(args.text.trim());const previousUser=recentDesc.find((r:any)=>r.role==="user"&&(r.transcript||r.content));const effectiveQuery=shortFollow&&previousUser?`${previousUser.transcript||previousUser.content} | ${plan.retrievalQuery}`:plan.retrievalQuery;
  const resolvedEntities=await resolveEntities(args.supabase,args.userId,effectiveQuery);const entityIds=resolvedEntities.map(e=>e.id);const includeDeepScope=CONFIG.historicalEvidenceEnabled&&(plan.depth==="deep"||plan.broadContext||entityIds.length>0);
  const [stateResult,embedding]=await Promise.all([plan.currentStateRelevant?args.supabase.from("current_state").select("*").eq("user_id",args.userId).eq("coach_key","default").maybeSingle():Promise.resolve({data:null,error:null}),args.useSemantic===false?Promise.resolve(null):embedQuery(effectiveQuery).catch(e=>{console.error("query embedding unavailable; lexical/entity fallback",e);return null;})]);
  const facets=plan.depth==="deep"&&!plan.broadContext?retrievalFacets(plan.domainHints):[];
  const runFacetRecords=facets.length>1?Promise.all(facets.map((facet)=>args.supabase.rpc("match_records_hybrid_v4",{p_user_id:args.userId,p_query_text:effectiveQuery,p_query_embedding:embedding,p_domain_hints:facet,p_required_domains:facet,p_entity_ids:[],p_strict_domain:true,p_match_count:Math.max(4,Math.ceil(plan.recordLimit/Math.max(facets.length,1))),p_min_similarity:0.14}))):Promise.resolve([]);
  const runFacetChunks=facets.length>1?Promise.all(facets.map((facet)=>args.supabase.rpc("match_source_chunks_hybrid_v4",{p_user_id:args.userId,p_query_text:effectiveQuery,p_query_embedding:embedding,p_domain_hints:facet,p_required_domains:facet,p_entity_ids:[],p_strict_domain:true,p_include_deep_scope:includeDeepScope,p_match_count:Math.max(2,Math.ceil(plan.chunkLimit/Math.max(facets.length,1))),p_min_similarity:0.14}))):Promise.resolve([]);
  const [recordsResult,chunksResult,profileResult,profileHistoryResult,facetRecordResults,facetChunkResults]=await Promise.all([
    args.supabase.rpc("match_records_hybrid_v4",{p_user_id:args.userId,p_query_text:effectiveQuery,p_query_embedding:embedding,p_domain_hints:plan.domainHints,p_required_domains:plan.requiredDomains,p_entity_ids:entityIds,p_strict_domain:plan.strictDomain,p_match_count:plan.recordLimit,p_min_similarity:plan.depth==="deep"?0.14:0.18}),
    args.supabase.rpc("match_source_chunks_hybrid_v4",{p_user_id:args.userId,p_query_text:effectiveQuery,p_query_embedding:embedding,p_domain_hints:plan.domainHints,p_required_domains:plan.requiredDomains,p_entity_ids:entityIds,p_strict_domain:plan.strictDomain,p_include_deep_scope:includeDeepScope,p_match_count:plan.chunkLimit,p_min_similarity:plan.depth==="deep"?0.14:0.18}),
    plan.broadContext?args.supabase.rpc("profile_records_v2",{p_user_id:args.userId,p_match_count:plan.profileLimit,p_per_facet:plan.depth==="deep"?4:3}):Promise.resolve({data:[],error:null}),
    plan.broadContext&&CONFIG.historicalEvidenceEnabled?args.supabase.rpc("profile_source_chunks_v1",{p_user_id:args.userId,p_match_count:plan.chunkLimit,p_per_facet:plan.depth==="deep"?3:2}):Promise.resolve({data:[],error:null}),
    runFacetRecords,
    runFacetChunks,
  ]);
  if(recordsResult.error)console.error("record retrieval error",recordsResult.error);if(chunksResult.error)console.error("chunk retrieval error",chunksResult.error);if(profileResult.error)console.error("profile retrieval error",profileResult.error);if(profileHistoryResult.error)console.error("profile history retrieval error",profileHistoryResult.error);
  for(const result of facetRecordResults as any[])if(result?.error)console.error("facet record retrieval error",result.error);
  for(const result of facetChunkResults as any[])if(result?.error)console.error("facet chunk retrieval error",result.error);
  const facetRecords=(facetRecordResults as any[]).flatMap((result:any)=>result?.data??[]),facetChunks=(facetChunkResults as any[]).flatMap((result:any)=>result?.data??[]);
  const hybrid=recordsResult.data??[],profile=profileResult.data??[];const relevantRecords=dedupeById([hybrid,facetRecords,profile]).slice(0,plan.broadContext?plan.profileLimit+10:plan.recordLimit);
  const relevantChunks=dedupeById([chunksResult.data??[],facetChunks,profileHistoryResult.data??[]]).slice(0,plan.chunkLimit);
  return{currentState:plan.currentStateRelevant?(stateResult.data??null):null,currentStateIncluded:plan.currentStateRelevant&&Boolean(stateResult.data),recentMessages:[...recentDesc].reverse(),relevantRecords,relevantChunks,resolvedEntities,semanticRetrieval:Boolean(embedding),domainHints:plan.domainHints,requiredDomains:plan.requiredDomains,strictDomain:plan.strictDomain,retrievalQuery:effectiveQuery,retrievalDepth:plan.depth,broadProfile:plan.broadProfile,broadContext:plan.broadContext,historicalEvidenceIncluded:includeDeepScope,hybridRecordCount:hybrid.length,profileRecordCount:profile.length,facetRecordCount:facetRecords.length,facetChunkCount:facetChunks.length};
}
