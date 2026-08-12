import { Redis } from '@upstash/redis';
import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';

export const maxDuration = 60;

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAN_TIME_MS = 180000;
const LOBBY_TTL_SECONDS = 21600;

const MODIFIERS = [
  { title:'MAKE IT WORSE', description:'Your plan must solve the problem while creating a second problem.' },
  { title:'NO NORMAL ANSWERS', description:'A boring textbook answer earns no style points. Find an unusual but plausible approach.' },
  { title:'POCKETS ONLY', description:'You may only rely on things you could reasonably carry on your person.' },
  { title:'ONE PERSON', description:'You cannot assume anyone else will help you.' },
  { title:'SPEED ROUND', description:'Your plan must work under extreme time pressure. Prioritize immediate actions.' },
  { title:'BROKE', description:'You have no money and cannot buy your way out of the situation.' },
  { title:'BIG BRAIN', description:'Find a clever, unconventional solution, but it still has to obey reality.' },
  { title:'MANDATORY DUCK', description:'Your plan must somehow involve a duck. The duck is real. The duck is not necessarily useful.' },
  { title:'ACT NORMAL', description:'Your plan must sound completely reasonable even though the situation is absurd.' },
  { title:'DOUBLE TROUBLE', description:'Your plan must account for the primary danger and one additional complication stated in the scenario.' },
];

const keyFor = code => `ooh:lobby:${code}`;
const lockKeyFor = code => `ooh:lock:${code}`;

function json(res,status,body){res.status(status).setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));}
function cleanName(v){return String(v||'').trim().replace(/\s+/g,' ').slice(0,24);}
function makeToken(){return crypto.randomBytes(24).toString('base64url');}
function makePlayerId(){return crypto.randomUUID();}
async function makeCode(){for(let tries=0;tries<80;tries++){let code='';for(let i=0;i<6;i++)code+=CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)];if(!(await redis.exists(keyFor(code))))return code;}return crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();}
async function getLobby(code){if(!code)return null;return await redis.get(keyFor(code));}
async function saveLobby(lobby){lobby.updatedAt=Date.now();await redis.set(keyFor(lobby.code),lobby,{ex:LOBBY_TTL_SECONDS});}
async function withLock(code,fn){const lk=lockKeyFor(code),token=crypto.randomUUID();for(let i=0;i<30;i++){const ok=await redis.set(lk,token,{nx:true,px:5000});if(ok){try{return await fn();}finally{const current=await redis.get(lk);if(current===token)await redis.del(lk);}}await new Promise(r=>setTimeout(r,40+i*8));}throw new Error('Lobby is busy. Try again.');}
function findPlayerByToken(lobby,token){return lobby?.players?.find(p=>p.token===token)||null;}
function pickModifier(round){return MODIFIERS[(Math.floor(Math.random()*MODIFIERS.length)+round-1)%MODIFIERS.length];}

function publicLobby(lobby,token){
  const me=findPlayerByToken(lobby,token);const activeConnected=lobby.players.filter(p=>p.connected!==false&&p.active!==false);
  return {code:lobby.code,state:lobby.state,round:lobby.round,hostPlayerId:lobby.hostPlayerId,myPlayerId:me?.id||null,
    players:lobby.players.map(p=>({id:p.id,name:p.name,isHost:p.id===lobby.hostPlayerId,submitted:Boolean(p.plan),active:p.active!==false,connected:p.connected!==false,survived:p.survived||0,failed:p.failed||0,streak:p.streak||0,score:p.score||0,acceptedRounds:p.acceptedRounds||0,rejectedRounds:p.rejectedRounds||0,funnyVotes:p.funnyVotes||0})),
    scenario:['scenario','judging','results'].includes(lobby.state)?lobby.scenario:null,deadline:lobby.deadline||null,verdicts:lobby.state==='results'?(lobby.verdicts||[]):[],judgingProgress:lobby.judgingProgress||null,submittedCount:activeConnected.filter(p=>Boolean(p.plan)).length,connectedCount:activeConnected.length,spectatorCount:lobby.players.filter(p=>p.connected!==false&&p.active===false).length,gameOver:Boolean(lobby.gameOver),aiEnabled:Boolean(ai),awards:lobby.gameOver?(lobby.awards||[]):[]};
}

function fallbackScenario(round,modifier){
 const scenarios=[
  {title:'THE COLLAPSING TRAIN',prompt:'You are inside the rear carriage of a commuter train stopped halfway across a damaged bridge. The front carriages have begun slipping over the edge. The bridge deck is cracking toward you. You have 6 minutes before engineers estimate the section beneath your carriage may fail.',facts:['The carriage doors still work manually.','The nearest stable end of the bridge is about 90 meters behind you.','There are 12 other passengers, some panicking but mobile.','You have your normal clothes, a phone with 18% battery, and a small backpack.','There is no guarantee emergency crews arrive within 6 minutes.'],objective:'Give a realistic plan that keeps you alive through the next 15 minutes.'},
  {title:'THE FLOODED MALL',prompt:'A flash flood has entered a two-story shopping mall after closing. Water on the first floor is already waist-deep and rising quickly. Power is flickering, and most exterior doors are locked by an electronic security system.',facts:['You are near an escalator to the second floor.','Water is rising roughly 20 cm per minute.','You have a phone, jacket, metal water bottle, and multitool.','There are skylights above the central atrium.','You cannot assume a rescue helicopter is already coming.'],objective:'Explain how you would maximize your chance of surviving until rescuers can reach the building.'},
  {title:'THE POWERLESS HOTEL',prompt:'A severe storm has knocked out power in a 20-story hotel. The emergency generator is unreliable, the elevators are offline, and smoke is beginning to enter one lower hallway.',facts:['You are on floor 14.','The stairwells are accessible.','Your phone has 31% battery.','Hotel staff are somewhere in the building, but you cannot assume they know your location.','The storm is expected to last at least two hours.'],objective:'Explain the safest sequence of actions for reaching a safer location and getting help.'}
 ];
 const base=scenarios[(round-1)%scenarios.length];return {...base,modifier};
}

async function generateScenario(round,modifier){
 if(!ai)return fallbackScenario(round,modifier);
 const prompt=`Create one tense but realistically survivable disaster scenario for round ${round} of the browser party game OUT OF HAND. Players independently explain how they survive. The game has this round modifier: ${modifier.title} — ${modifier.description}. Difficulty should increase gradually. Never require illegal, violent, or harmful instructions against other people. Avoid obscure trivia.

Return ONLY valid JSON with this exact shape:
{"title":"short uppercase title","prompt":"2-4 sentence situation","facts":["fact 1","fact 2","fact 3","fact 4","fact 5"],"objective":"one sentence survival objective"}

Every crucial constraint needed to judge a plan must be explicitly stated. Do not invent hidden exits or required actions. The modifier must be possible to follow using the stated scenario. Do not make the scenario itself depend on the player already knowing the modifier.`;
 try{const response=await ai.models.generateContent({model:MODEL,contents:prompt,config:{responseMimeType:'application/json',temperature:1.0}});const parsed=JSON.parse(response.text);if(!parsed?.title||!parsed?.prompt||!Array.isArray(parsed?.facts))throw new Error('Bad scenario JSON');return {...parsed,modifier};}catch(e){console.error('Scenario generation failed:',e.message);return fallbackScenario(round,modifier);}
}

function fallbackVerdict(player){const accepted=(player.plan||'').trim().length>=120;return {playerId:player.id,playerName:player.name,verdict:accepted?'ACCEPTED':'REJECTED',vote:accepted?'4-1':'1-4',jurors:[
 {name:'LOGIC',vote:accepted?'ACCEPT':'REJECT',note:accepted?'The plan contains enough actual steps to evaluate.':'The plan is too vague to establish a usable sequence.'},
 {name:'REALISM',vote:accepted?'ACCEPT':'REJECT',note:accepted?'No obvious impossible assumption dominates the plan.':'Reality has declined to participate in this plan.'},
 {name:'RESOURCES',vote:accepted?'ACCEPT':'REJECT',note:accepted?'The plan appears to respect the stated resources.':'The plan quietly invents equipment. The jury noticed.'},
 {name:'SURVIVAL',vote:accepted?'ACCEPT':'REJECT',note:accepted?'The actions generally reduce the immediate danger.':'The plan somehow makes survival feel optional.'},
 {name:'SKEPTIC',vote:'REJECT',note:'I have concerns. Mostly about the confidence level of this submission.'}],summary:accepted?'Barely defensible, but the jury can see a path to survival.':'This plan has been rejected by reality itself.',plan:player.plan||'No plan was submitted before time expired.'};}

async function judgeAll(scenario,contestants){
 if(!ai)return contestants.map(fallbackVerdict);
 const submissions=contestants.map(p=>({playerId:p.id,playerName:p.name,plan:(p.plan||'').trim()||'No plan was submitted before time expired.'}));
 const prompt=`You are the five-member jury of OUT OF HAND, a chaotic multiplayer survival comedy game.

Judge every submitted plan independently against ONLY the stated scenario facts, the round modifier, and ordinary common knowledge. A plan can be imperfect and still pass if it gives a plausible path to survival.

Be BRUTAL, FUNNY, SARCASTIC, and SPECIFIC. Roast the PLAN, not the real person. Do not be hateful or cruel toward the player. Do not use generic filler. Reference absurd or clever details from the submission. Each juror gets 1-2 short sentences. The chairperson gets 2-3 short sentences.

JUROR PERSONALITIES:
LOGIC: pedantic and irritated by nonsense.
REALISM: refuses impossible physics and magical assumptions.
RESOURCES: notices invented equipment and missing supplies.
SURVIVAL: cares about whether the plan actually keeps someone alive.
SKEPTIC: assumes the plan is suspicious until proven otherwise.

SCENARIO:
${JSON.stringify(scenario)}

SUBMISSIONS:
${JSON.stringify(submissions)}

Return ONLY valid JSON:
{"verdicts":[{"playerId":"copy exact playerId","playerName":"copy player name","verdict":"ACCEPTED or REJECTED","vote":"for example 4-1","jurors":[{"name":"LOGIC","vote":"ACCEPT or REJECT","note":"brief brutal/funny finding"},{"name":"REALISM","vote":"ACCEPT or REJECT","note":"brief brutal/funny finding"},{"name":"RESOURCES","vote":"ACCEPT or REJECT","note":"brief brutal/funny finding"},{"name":"SURVIVAL","vote":"ACCEPT or REJECT","note":"brief brutal/funny finding"},{"name":"SKEPTIC","vote":"ACCEPT or REJECT","note":"brief brutal/funny finding"}],"summary":"short sarcastic chairperson verdict"}]}

The majority juror vote MUST match the verdict. Keep every note concise enough to display on a game screen.`;
 try{const response=await ai.models.generateContent({model:MODEL,contents:prompt,config:{responseMimeType:'application/json',temperature:0.85}});const data=JSON.parse(response.text);const byId=new Map((data.verdicts||[]).map(v=>[v.playerId,v]));return contestants.map(p=>{const raw=byId.get(p.id);if(!raw)return fallbackVerdict(p);const verdict=String(raw.verdict).toUpperCase()==='ACCEPTED'?'ACCEPTED':'REJECTED';return {...raw,playerId:p.id,playerName:p.name,verdict,plan:(p.plan||'').trim()||'No plan was submitted before time expired.'};});}catch(e){console.error('Batch judging failed:',e.message);throw e;}
}

function buildAwards(lobby){
 const players=[...lobby.players];
 if(!players.length)return [];
 const top=(arr,fn)=>arr.reduce((best,p)=>best===null||fn(p)>fn(best)?p:best,null);
 const awards=[];
 const champion=top(players,p=>p.score||0); if(champion)awards.push({icon:'🏆',title:'OUT OF HAND CHAMPION',playerName:champion.name,description:`${champion.score||0} total jury points. Somehow the jury trusted this person.`});
 const brain=top(players,p=>(p.acceptedRounds||0)/Math.max(1,(p.acceptedRounds||0)+(p.rejectedRounds||0))); if(brain)awards.push({icon:'🧠',title:'BIGGEST BRAIN',playerName:brain.name,description:`${Math.round(((brain.acceptedRounds||0)/Math.max(1,(brain.acceptedRounds||0)+(brain.rejectedRounds||0)))*100)}% acceptance rate.`});
 const unhinged=top(players,p=>p.rejectedRounds||0); if(unhinged)awards.push({icon:'💀',title:'MOST UNHINGED',playerName:unhinged.name,description:`${unhinged.rejectedRounds||0} rejected plans. Consistency is admirable.`});
 const streak=top(players,p=>p.bestStreak||p.streak||0); if(streak)awards.push({icon:'🔥',title:'SURVIVAL STREAK',playerName:streak.name,description:`Best streak: ${streak.bestStreak||streak.streak||0} consecutive clears.`});
 const menace=top(players,p=>p.funnyVotes||0); if(menace)awards.push({icon:'🚨',title:'PROFESSIONAL MENACE',playerName:menace.name,description:`The jury flagged this player's plans as unusually entertaining.`});
 return awards;
}

async function actionCreate(name){const clean=cleanName(name);if(!clean)throw new Error('Enter a name.');const code=await makeCode(),token=makeToken(),id=makePlayerId();const player={id,token,name:clean,connected:true,active:true,plan:'',survived:0,failed:0,streak:0,bestStreak:0,score:0,acceptedRounds:0,rejectedRounds:0,funnyVotes:0};const lobby={code,hostPlayerId:id,players:[player],round:0,state:'lobby',scenario:null,verdicts:[],gameOver:false,deadline:null,judgingProgress:null,awards:[],createdAt:Date.now()};await saveLobby(lobby);return {token,lobby:publicLobby(lobby,token)};}
async function actionJoin(code,name){const cleanCode=String(code||'').trim().toUpperCase(),clean=cleanName(name);if(!clean)throw new Error('Enter a name.');const token=makeToken();return await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode);if(!lobby)throw new Error('That host code does not exist.');if(lobby.state!=='lobby')throw new Error('That game has already started.');if(lobby.players.some(p=>p.name.toLowerCase()===clean.toLowerCase()))throw new Error('That name is already in this lobby.');const id=makePlayerId();lobby.players.push({id,token,name:clean,connected:true,active:true,plan:'',survived:0,failed:0,streak:0,bestStreak:0,score:0,acceptedRounds:0,rejectedRounds:0,funnyVotes:0});await saveLobby(lobby);return {token,lobby:publicLobby(lobby,token)};});}


async function actionKick(code,token,targetPlayerId){const cleanCode=String(code||'').trim().toUpperCase();return await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode),host=findPlayerByToken(lobby,token);if(!lobby||!host||host.id!==lobby.hostPlayerId)throw new Error('Only the host can kick players.');if(lobby.state!=='lobby')throw new Error('Players can only be kicked while the lobby is waiting.');const index=lobby.players.findIndex(p=>p.id===String(targetPlayerId||''));if(index<0)throw new Error('That player is no longer in the lobby.');if(lobby.players[index].id===lobby.hostPlayerId)throw new Error('You cannot kick the host.');lobby.players.splice(index,1);await saveLobby(lobby);return publicLobby(lobby,token);});}

async function actionStart(code,token){const cleanCode=String(code||'').trim().toUpperCase();let round;await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode),player=findPlayerByToken(lobby,token);if(!lobby||!player||player.id!==lobby.hostPlayerId)throw new Error('Only the host can start.');if(!['lobby','results'].includes(lobby.state))throw new Error('A round is already running.');if(lobby.state==='results'&&lobby.gameOver){lobby.round=0;lobby.gameOver=false;lobby.scenario=null;lobby.verdicts=[];lobby.deadline=null;lobby.awards=[];lobby.players.forEach(p=>{p.plan='';p.active=true;p.survived=0;p.failed=0;p.streak=0;p.bestStreak=0;p.score=0;p.acceptedRounds=0;p.rejectedRounds=0;p.funnyVotes=0;});}if(!lobby.players.some(p=>p.connected!==false&&p.active!==false))throw new Error('No active players remain. Start a new game.');lobby.round+=1;round=lobby.round;const modifier=pickModifier(round);lobby.state='loading';lobby.scenario=null;lobby.verdicts=[];lobby.deadline=null;lobby.judgingProgress=null;lobby.awards=[];lobby.players.forEach(p=>{p.plan='';});lobby.pendingModifier=modifier;await saveLobby(lobby);});
 const scenario=await generateScenario(round,(await getLobby(cleanCode)).pendingModifier);
 return await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode);if(!lobby||lobby.state!=='loading'||lobby.round!==round)throw new Error('Round state changed while loading.');lobby.scenario=scenario;lobby.pendingModifier=null;lobby.state='scenario';lobby.deadline=Date.now()+PLAN_TIME_MS;await saveLobby(lobby);return publicLobby(lobby,token);});}

async function actionSubmit(code,token,plan){const cleanCode=String(code||'').trim().toUpperCase();return await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode),player=findPlayerByToken(lobby,token);if(!lobby||!player||lobby.state!=='scenario')throw new Error('Plans are not being accepted right now.');if(player.active===false)throw new Error('You were eliminated and are spectating this game.');const cleanPlan=String(plan||'').trim().slice(0,5000);if(cleanPlan.length<3)throw new Error('Give the jury an actual answer.');if(player.plan)throw new Error('Your plan is already locked.');player.plan=cleanPlan;await saveLobby(lobby);return publicLobby(lobby,token);});}

async function actionMaybeJudge(code,token){const cleanCode=String(code||'').trim().toUpperCase();let snapshot=null;await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode);if(!lobby)throw new Error('Lobby not found.');if(lobby.state!=='scenario')return;const contestants=lobby.players.filter(p=>p.connected!==false&&p.active!==false);const allSubmitted=contestants.length>0&&contestants.every(p=>Boolean(p.plan));const expired=lobby.deadline&&Date.now()>=lobby.deadline;if(!allSubmitted&&!expired)return;lobby.state='judging';lobby.deadline=null;lobby.judgingProgress={done:0,total:contestants.length};snapshot={round:lobby.round,scenario:lobby.scenario,contestants:contestants.map(p=>({...p}))};await saveLobby(lobby);});if(!snapshot){const lobby=await getLobby(cleanCode);return publicLobby(lobby,token);}let verdicts;try{verdicts=await judgeAll(snapshot.scenario,snapshot.contestants);}catch(e){console.error('Judge request failed:',e.message);return await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode);if(!lobby||lobby.state!=='judging')return publicLobby(lobby,token);lobby.state='scenario';lobby.deadline=Date.now()+15000;await saveLobby(lobby);throw new Error('The jury timed out. Giving everyone 15 more seconds before trying again.');});}
 return await withLock(cleanCode,async()=>{const lobby=await getLobby(cleanCode);if(!lobby||lobby.state!=='judging'||lobby.round!==snapshot.round)return publicLobby(lobby,token);for(const verdict of verdicts){const player=lobby.players.find(p=>p.id===verdict.playerId);if(!player)continue;const acceptVotes=(verdict.jurors||[]).filter(j=>String(j.vote||'').toUpperCase().includes('ACCEPT')).length;verdict.roundScore=acceptVotes;player.score=(player.score||0)+acceptVotes;if(verdict.verdict==='ACCEPTED'){player.survived=(player.survived||0)+1;player.acceptedRounds=(player.acceptedRounds||0)+1;player.streak=(player.streak||0)+1;player.bestStreak=Math.max(player.bestStreak||0,player.streak||0);player.active=true;}else{player.failed=(player.failed||0)+1;player.rejectedRounds=(player.rejectedRounds||0)+1;player.streak=0;player.active=false;}}
lobby.verdicts=verdicts;lobby.state='results';lobby.judgingProgress=null;lobby.gameOver=!lobby.players.some(p=>p.connected!==false&&p.active!==false);if(lobby.gameOver)lobby.awards=buildAwards(lobby);await saveLobby(lobby);return publicLobby(lobby,token);});}

export default async function handler(req,res){try{if(req.method==='GET'){const code=String(req.query.code||'').trim().toUpperCase(),token=String(req.query.token||''),lobby=await getLobby(code);if(!lobby)return json(res,404,{ok:false,error:'Lobby not found.'});if(token&&!findPlayerByToken(lobby,token))return json(res,403,{ok:false,error:'You were kicked from this lobby.'});return json(res,200,{ok:true,lobby:publicLobby(lobby,token)});}if(req.method!=='POST')return json(res,405,{ok:false,error:'Method not allowed.'});const body=req.body||{},action=body.action;let result;if(action==='create')result=await actionCreate(body.name);else if(action==='join')result=await actionJoin(body.code,body.name);else if(action==='kick')result={lobby:await actionKick(body.code,body.token,body.playerId)};else if(action==='start')result={lobby:await actionStart(body.code,body.token)};else if(action==='submit')result={lobby:await actionSubmit(body.code,body.token,body.plan)};else if(action==='maybeJudge')result={lobby:await actionMaybeJudge(body.code,body.token)};else throw new Error('Unknown action.');return json(res,200,{ok:true,...result});}catch(e){console.error(e);return json(res,400,{ok:false,error:e.message||'Request failed.'});}}
