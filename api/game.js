import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const TTL = 60 * 60 * 6;
const ROUNDS = 7;
const MAX_REPLY = 500;

const modifiers = [
  {name:"NORMAL", rule:"Respond naturally."},
  {name:"PROFESSIONAL", rule:"Respond as professionally as possible."},
  {name:"ONE WORD", rule:"Your entire reply must be exactly one word."},
  {name:"NO EMOJIS", rule:"Do not use emojis."},
  {name:"GEN Z", rule:"Use believable modern internet texting language without becoming unreadable."},
  {name:"POLITE", rule:"Be especially polite and tactful."},
  {name:"CHAOTIC", rule:"Be funny and unusual, but still respond to the message."},
  {name:"DESPERATE", rule:"You badly need the sender to agree with you."}
];

function id(){return Math.random().toString(36).slice(2,10)}
function key(code){return `dmd:${code}`}
function clean(s){return String(s||"").trim().replace(/\s+/g," ").slice(0,MAX_REPLY)}
function scoreCap(round){return round>=7?150:round===6?125:100}

async function load(code){return await redis.get(key(code))}
async function save(code,g){await redis.set(key(code),g,{ex:TTL})}
function json(res,status,obj){res.status(status).json(obj)}

async function gemini(prompt){
  const apiKey=process.env.GEMINI_API_KEY;
  if(!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
    contents:[{parts:[{text:prompt}]}],
    generationConfig:{temperature:0.9,responseMimeType:"application/json"}
  })});
  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||"AI request failed.");
  const text=data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error("AI returned no content.");
  return JSON.parse(text.replace(/^```json\s*/,"").replace(/\s*```$/,""));
}

async function generateRound(round){
  const mod=modifiers[Math.floor(Math.random()*modifiers.length)];
  const prompt=`You are the scenario writer for a multiplayer party game called DM'D.
Generate ONE realistic but entertaining text message situation.
Return JSON only:
{"sender":"generic relationship/title","dm":"the exact DM message","modifier":"${mod.name}"}
Rules:
- sender must be a generic title, never a real person's name. Examples: YOUR BOSS, YOUR FRIEND, YOUR TEACHER, YOUR ROOMMATE, YOUR CRUSH, A STRANGER, YOUR PARENT, YOUR COWORKER, A DELIVERY DRIVER.
- The DM should be 1-3 natural sentences.
- It must be answerable with exactly one reply.
- Avoid dangerous, illegal, sexual, hateful, or graphic scenarios.
- Do not explain the scenario.
- Modifier rule: ${mod.rule}
- Round ${round} of ${ROUNDS}; make later rounds slightly more awkward or difficult.`;
  const x=await gemini(prompt);
  return {sender:String(x.sender||"YOUR FRIEND").slice(0,40),dm:String(x.dm||"hey, can you help me with something?").slice(0,600),modifier:mod.name};
}

async function judge(g){
  const cap=scoreCap(g.round);
  const entries=g.players.filter(p=>p.submission).map(p=>({id:p.id,name:p.name,reply:p.submission}));
  if(!entries.length) return;
  const mod=modifiers.find(x=>x.name===g.modifier)?.rule||"Respond naturally.";
  const prompt=`You are the silent scoring judge for DM'D, a multiplayer party game.
Situation sender: ${g.sender}
DM: ${g.dm}
Round modifier: ${g.modifier}
Modifier rule: ${mod}
Score these player replies from 0 to ${cap}.
Judge the quality of the reply for the exact DM and modifier. Consider naturalness, context awareness, appropriateness, creativity, and humor when appropriate.
IMPORTANT: Return JSON only in this exact shape:
{"scores":[{"id":"player id","score":number}]}
Do not return commentary, explanations, names, rankings, or extra fields.
Players:
${entries.map(e=>`ID=${e.id}\nREPLY=${e.reply}`).join("\n\n")}`;
  const x=await gemini(prompt);
  const byId=new Map((x.scores||[]).map(s=>[String(s.id),Math.max(0,Math.min(cap,Math.round(Number(s.score)||0)))]));
  for(const p of g.players){p.roundScore=byId.get(p.id)||0;p.total=(p.total||0)+p.roundScore}
  g.phase="results";
}

async function awards(g){
  const prompt=`Create 4 fun end-of-game awards for these players in a texting party game.
Return JSON only: {"awards":[{"title":"short award title","player":"exact player name"}]}
Use only these players:
${g.players.map(p=>p.name).join(", ")}
Awards should be harmless and funny. Do not duplicate players if avoidable.`;
  try{
    const x=await gemini(prompt);
    return Array.isArray(x.awards)?x.awards.slice(0,4):[];
  }catch{return []}
}

export default async function handler(req,res){
  try{
    const body=req.method==="POST"?req.body||{}:{};
    const action=body.action;
    if(!action)return json(res,400,{error:"Missing action."});

    if(action==="create"){
      const code=id().toUpperCase();
      const playerId=id();
      const g={code,hostId:playerId,phase:"lobby",round:0,players:[{id:playerId,name:clean(body.name)||"Player",total:0}],createdAt:Date.now()};
      await save(code,g);
      return json(res,200,{code,playerId});
    }

    if(action==="join"){
      const code=clean(body.code).toUpperCase();
      const g=await load(code);
      if(!g) return json(res,404,{error:"Lobby not found."});
      if(g.phase!=="lobby") return json(res,400,{error:"That game has already started."});
      if(g.players.length>=12) return json(res,400,{error:"Lobby is full."});
      const playerId=id();
      g.players.push({id:playerId,name:clean(body.name)||"Player",total:0});
      await save(code,g);
      return json(res,200,{code,playerId});
    }

    const g=await load(clean(body.code).toUpperCase());
    if(!g)return json(res,404,{error:"Lobby not found."});
    const me=g.players.find(p=>p.id===body.playerId);

    if(action==="state"){
      if(!me)return json(res,403,{error:"You are not in this lobby."});
      const out={code:g.code,phase:g.phase,round:g.round,modifier:g.modifier,sender:g.sender,dm:g.dm,hostId:g.hostId,
        players:g.players.map(p=>({id:p.id,name:p.name,submitted:!!p.submission})),
        mySubmission:!!me.submission};
      if(g.phase==="results")out.scores=g.players.slice().sort((a,b)=>b.roundScore-a.roundScore).map(p=>({name:p.name,score:p.roundScore}));
      if(g.phase==="final")out.scores=g.players.slice().sort((a,b)=>b.total-a.total).map(p=>({name:p.name,total:p.total}));
      if(g.awards)out.awards=g.awards;
      return json(res,200,out);
    }

    if(action==="kick"){
      if(body.playerId!==g.hostId)return json(res,403,{error:"Only the host can kick players."});
      if(body.targetId===g.hostId)return json(res,400,{error:"The host cannot kick themselves."});
      const target=g.players.find(p=>p.id===body.targetId);
      if(!target)return json(res,404,{error:"Player not found."});
      g.players=g.players.filter(p=>p.id!==body.targetId);
      await save(g.code,g);
      return json(res,200,{ok:true});
    }

    if(action==="start"){
      if(body.playerId!==g.hostId)return json(res,403,{error:"Only the host can start the game."});
      if(g.players.length<2)return json(res,400,{error:"You need at least 2 players."});
      g.round=1;Object.assign(g,await generateRound(1));g.phase="round";g.players.forEach(p=>{delete p.submission;p.roundScore=0});
      await save(g.code,g);return json(res,200,{ok:true});
    }

    if(action==="submit"){
      if(!me)return json(res,403,{error:"You are not in this lobby."});
      if(g.phase!=="round")return json(res,400,{error:"Submissions are closed."});
      const text=clean(body.text);
      if(!text || text.length<3)return json(res,400,{error:"Write at least a few characters."});
      if(me.submission)return json(res,400,{error:"You already submitted."});
      me.submission=text;
      if(g.players.every(p=>p.submission)){await judge(g)}
      await save(g.code,g);return json(res,200,{ok:true});
    }

    if(action==="next"){
      if(body.playerId!==g.hostId)return json(res,403,{error:"Only the host can continue."});
      if(g.phase!=="results")return json(res,400,{error:"The round is not finished."});
      if(g.round>=ROUNDS){g.phase="final";g.awards=await awards(g);await save(g.code,g);return json(res,200,{ok:true})}
      g.round++;g.players.forEach(p=>{delete p.submission;p.roundScore=0});Object.assign(g,await generateRound(g.round));g.phase="round";await save(g.code,g);return json(res,200,{ok:true});
    }

    return json(res,400,{error:"Unknown action."});
  }catch(e){
    console.error(e);
    return json(res,400,{error:e.message||"Server error."});
  }
}
