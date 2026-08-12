const $ = id => document.getElementById(id);
let state = {code:null, me:null, poll:null, lastScreen:null, openResponse:null};

async function api(body){
  const r = await fetch("/api/game", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data = await r.json().catch(()=>({error:"Bad server response"}));
  if(!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
function show(id){document.querySelectorAll(".screen").forEach(x=>x.classList.remove("active"));$(id).classList.add("active");state.lastScreen=id}
function setStatus(id,msg){$(id).textContent=msg||""}
function name(){return ($("nameInput").value||"Player").trim().slice(0,24)||"Player"}

$("joinBtn").onclick=()=>{$("joinBox").classList.toggle("hidden");$("codeInput").focus()}
$("createBtn").onclick=async()=>{try{const d=await api({action:"create",name:name()});enterLobby(d)}catch(e){setStatus("homeStatus",e.message)}}
$("joinCodeBtn").onclick=async()=>{try{const d=await api({action:"join",code:$("codeInput").value.trim().toUpperCase(),name:name()});enterLobby(d)}catch(e){setStatus("homeStatus",e.message)}}
$("leaveBtn").onclick=()=>{if(state.poll)clearInterval(state.poll);location.reload()}
$("startBtn").onclick=async()=>{try{await api({action:"start",code:state.code,playerId:state.me});await refresh()}catch(e){setStatus("lobbyInfo",e.message)}}
$("replyInput").addEventListener("input",()=>{$("charCount").textContent=`${$("replyInput").value.length} / 500`})
$("submitReply").onclick=async()=>{const text=$("replyInput").value.trim();if(!text){setStatus("roundStatus","Type a reply first.");return}try{await api({action:"submit",code:state.code,playerId:state.me,text});$("submitReply").disabled=true;setStatus("roundStatus","Submitted. The jury is judging.");$("waitingCard").classList.remove("hidden");await refresh()}catch(e){setStatus("roundStatus",e.message)}}
$("nextRoundBtn").onclick=async()=>{try{await api({action:"next",code:state.code,playerId:state.me});await refresh()}catch(e){setStatus("roundStatus",e.message)}}
$("returnLobbyBtn").onclick=()=>show("lobby")

function enterLobby(d){state.code=d.code;state.me=d.playerId;show("lobby");refresh();if(state.poll)clearInterval(state.poll);state.poll=setInterval(refresh,900)}
async function refresh(){
  if(!state.code)return;
  try{
    const d=await api({action:"state",code:state.code,playerId:state.me});
    render(d);
  }catch(e){console.warn(e.message)}
}
function render(d){
  $("lobbyCode").textContent=d.code||"";
  if(d.phase==="lobby"){
    show("lobby");
    $("startBtn").style.display=d.hostId===state.me?"block":"none";
    $("lobbyInfo").textContent=d.players.length<2?"Waiting for another player...":"Ready when the host is ready.";
    $("playerList").innerHTML=d.players.map(p=>`<div class="player"><span>${esc(p.name)} ${p.id===d.hostId?'<span class="hostBadge">HOST</span>':''}</span>${d.hostId===state.me&&p.id!==state.me?`<button class="kick" data-kick="${p.id}">KICK</button>`:""}</div>`).join("");
    document.querySelectorAll("[data-kick]").forEach(b=>b.onclick=()=>kick(b.dataset.kick));
  } else if(d.phase==="round"){
    show("round");
    $("roundNumber").textContent=`${d.round} / 7`;
    $("modifierPill").textContent=d.modifier;
    $("senderTitle").textContent=d.sender;
    $("dmText").textContent=d.dm;
    $("replyInput").disabled=!!d.mySubmission;
    $("submitReply").disabled=!!d.mySubmission;
    $("waitingCard").classList.toggle("hidden",!d.mySubmission);
    $("submittedList").innerHTML=d.players.map(p=>`<div class="player"><span>${esc(p.name)}</span><span>${p.submitted?"✓":"..."}</span></div>`).join("");
  } else if(d.phase==="results"){
    show("results");
    $("resultsRound").textContent=`ROUND ${d.round}`;
    $("scoreList").innerHTML=d.scores.map(x=>`<div class="scoreRow"><span>${esc(x.name)}</span><span class="score">${x.score}</span></div>`).join("");
    $("nextRoundBtn").style.display=d.hostId===state.me?"block":"none";
  } else if(d.phase==="final"){
    show("final");
    $("finalScores").innerHTML=d.scores.map(x=>`<div class="scoreRow"><span>${esc(x.name)}</span><span class="score">${x.total}</span></div>`).join("");
    $("awards").innerHTML=(d.awards||[]).map(a=>`<div class="award"><div class="awardName">${esc(a.title)}</div><div class="awardPlayer">${esc(a.player)}</div></div>`).join("");
  }
}
async function kick(id){
  if(!confirm("Kick this player from the lobby?"))return;
  try{await api({action:"kick",code:state.code,playerId:state.me,targetId:id});await refresh()}catch(e){alert(e.message)}
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
