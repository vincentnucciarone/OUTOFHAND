let lobby = null;
let myId = null;
let playerToken = localStorage.getItem('ooh_player_token') || '';
let lobbyCode = localStorage.getItem('ooh_lobby_code') || '';
let timerHandle = null;
let pollHandle = null;
let lastScenarioRound = null;
let judgingRequestInFlight = false;

const screens = [...document.querySelectorAll('.screen')];
const $ = id => document.getElementById(id);

function showScreen(name){ screens.forEach(s => s.classList.toggle('active', s.id === `screen-${name}`)); }
function escapeHtml(value=''){ return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function showError(msg){ const el=$('homeError'); el.textContent=msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),3500); }
function me(){ return lobby?.players?.find(p=>p.id===myId); }
function amHost(){ return lobby?.hostPlayerId===myId; }
function fmt(ms){ const sec=Math.max(0,Math.ceil(ms/1000)); return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`; }

async function api(body){
  const r = await fetch('/api/game',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json().catch(()=>({ok:false,error:'Invalid server response.'}));
  if(!data.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function adopt(data){
  if(data.token){
    playerToken=data.token;
    localStorage.setItem('ooh_player_token',playerToken);
  }
  if(data.lobby){
    lobby=data.lobby;
    lobbyCode=lobby.code;
    myId=lobby.myPlayerId;
    localStorage.setItem('ooh_lobby_code',lobbyCode);
    renderState();
    ensurePolling();
  }
}

async function poll(){
  if(!lobbyCode || !playerToken) return;
  try{
    const r=await fetch(`/api/game?code=${encodeURIComponent(lobbyCode)}&token=${encodeURIComponent(playerToken)}`,{cache:'no-store'});
    const data=await r.json();
    if(!data.ok) return;
    adopt(data);
    maybeTriggerJudging();
  }catch{}
}

function ensurePolling(){
  if(pollHandle) return;
  pollHandle=setInterval(poll,1000);
}

async function maybeTriggerJudging(){
  if(judgingRequestInFlight || !lobby || lobby.state!=='scenario') return;
  const allSubmitted=(lobby.connectedCount||0)>0 && (lobby.submittedCount||0)>=(lobby.connectedCount||0);
  const expired=lobby.deadline && Date.now()>=lobby.deadline;
  if(!allSubmitted && !expired) return;
  judgingRequestInFlight=true;
  try{ adopt(await api({action:'maybeJudge',code:lobby.code,token:playerToken})); }
  catch(e){ console.warn(e); }
  finally{ judgingRequestInFlight=false; }
}

$('hostForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{ adopt(await api({action:'create',name:$('hostName').value})); }
  catch(err){ showError(err.message); }
});
$('joinForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{ adopt(await api({action:'join',code:$('joinCode').value,name:$('joinName').value})); }
  catch(err){ showError(err.message); }
});
$('copyCode').onclick=()=>navigator.clipboard?.writeText(lobby?.code||'');
$('startGame').onclick=async()=>{ try{ adopt(await api({action:'start',code:lobby.code,token:playerToken})); }catch(e){alert(e.message)} };
$('nextRound').onclick=async()=>{ try{ adopt(await api({action:'start',code:lobby.code,token:playerToken})); }catch(e){alert(e.message)} };
$('planInput').addEventListener('input',()=>{$('charCount').textContent=`${$('planInput').value.length} / 5000`});
$('submitPlan').onclick=async()=>{
  try{
    adopt(await api({action:'submit',code:lobby.code,token:playerToken,plan:$('planInput').value}));
    $('planInput').disabled=true; $('submitPlan').disabled=true; $('submitPlan').textContent='PLAN LOCKED'; $('submitStatus').textContent='Submitted. Waiting for everyone else.';
    maybeTriggerJudging();
  }catch(e){ $('submitStatus').textContent=e.message; }
};

function renderState(){
  if(!lobby) return showScreen('home');
  clearInterval(timerHandle);
  if(lobby.state==='lobby') renderLobby();
  else if(lobby.state==='loading') renderLobby();
  else if(lobby.state==='scenario') renderScenario();
  else if(lobby.state==='judging') renderJudging();
  else if(lobby.state==='results') renderResults();
}

function renderLobby(){
  showScreen('lobby');
  $('lobbyCode').textContent=lobby.code;
  $('playerCount').textContent=lobby.players.length;
  $('aiMode').textContent=lobby.aiEnabled?'● GEMINI JURY ONLINE':'○ DEMO JURY — ADD GEMINI_API_KEY';
  $('roster').innerHTML=lobby.players.map(p=>`<div class="player-row ${p.connected?'':'offline'}"><span class="dot"></span><span class="name">${escapeHtml(p.name)}</span>${p.isHost?'<span class="host-tag">HOST</span>':''}<span class="stats">${p.score||0} PTS · ${p.survived} SURVIVED</span></div>`).join('');
  $('startGame').classList.toggle('hidden',!amHost());
  $('waitingHost').classList.toggle('hidden',amHost());
  $('startGame').innerHTML=lobby.round>0?'START NEXT ROUND <span>→</span>':'START ROUND <span>→</span>';
}
function renderScenario(){
  showScreen('scenario');
  const isNewScenario=lastScenarioRound!==lobby.round;
  if(isNewScenario){
    lastScenarioRound=lobby.round;
    $('planInput').value=''; $('charCount').textContent='0 / 5000'; $('submitStatus').textContent='Your answer cannot be edited after submission.';
  }
  $('scenarioRound').textContent=`ROUND ${lobby.round}`;
  $('scenarioTitle').textContent=lobby.scenario.title;
  $('scenarioPrompt').textContent=lobby.scenario.prompt;
  $('scenarioFacts').innerHTML=(lobby.scenario.facts||[]).map((f,i)=>`<div class="fact"><span class="fact-num">0${i+1}</span><span>${escapeHtml(f)}</span></div>`).join('');
  $('scenarioObjective').textContent=lobby.scenario.objective;
  $('submittedCounter').textContent=`${lobby.submittedCount||0} / ${lobby.connectedCount||0} READY`;
  const mine=me(); const eliminated=mine?.active===false;
  $('planInput').classList.toggle('hidden',eliminated); $('submitPlan').classList.toggle('hidden',eliminated); $('charCount').classList.toggle('hidden',eliminated);
  if(eliminated){
    $('submitStatus').textContent=`You were eliminated earlier. Spectating Round ${lobby.round} · ${lobby.connectedCount||0} competitor${(lobby.connectedCount||0)===1?'':'s'} remain.`;
  }else if(mine?.submitted){
    $('planInput').disabled=true; $('submitPlan').disabled=true; $('submitPlan').textContent='PLAN LOCKED'; $('submitStatus').textContent='Submitted. Waiting for everyone else.';
  }else{
    $('planInput').disabled=false; $('submitPlan').disabled=false; $('submitPlan').innerHTML='LOCK PLAN <span>✓</span>'; $('submitStatus').textContent='Your answer cannot be edited after submission.';
  }
  const tick=()=>{ const left=lobby.deadline-Date.now(); $('timer').textContent=fmt(left); $('timer').classList.toggle('danger',left<30000); if(left<=0){ $('planInput').disabled=true; $('submitPlan').disabled=true; maybeTriggerJudging(); } };
  tick(); timerHandle=setInterval(tick,200);
}
function renderJudging(){
  showScreen('judging'); $('judgingRound').textContent=`ROUND ${lobby.round}`;
  const p=lobby.judgingProgress||{done:0,total:lobby.connectedCount||0};
  $('judgeProgressText').textContent=`${p.done} / ${p.total} CASES REVIEWED`;
  $('judgeProgressBar').style.width=p.total?`${(p.done/p.total)*100}%`:'10%';
}
function renderResults(){
  showScreen('results'); $('resultsRound').textContent=`ROUND ${lobby.round} RESULTS`;
  const mine=lobby.verdicts.find(v=>v.playerId===myId); const minePlayer=me();
  if(mine){
    $('myVerdict').className=`my-verdict ${mine.verdict==='ACCEPTED'?'accept':'reject'}`;
    $('myVerdict').innerHTML=`<span class="eyebrow">YOUR VERDICT</span><strong>${mine.verdict}</strong><span>${escapeHtml(mine.vote||'')}</span>`;
  }else if(minePlayer?.active===false){
    $('myVerdict').className='my-verdict reject';
    $('myVerdict').innerHTML='<span class="eyebrow">YOUR STATUS</span><strong>SPECTATING</strong><span>ELIMINATED IN AN EARLIER ROUND</span>';
  }else{ $('myVerdict').className='my-verdict'; $('myVerdict').innerHTML=''; }

  $('verdictList').innerHTML=lobby.verdicts.map((v,i)=>{
    const accepted=v.verdict==='ACCEPTED';
    const jurors=(v.jurors||[]).map(j=>`<div class="juror"><div class="juror-name">${escapeHtml(j.name||'JUROR')}</div><div class="juror-vote ${String(j.vote).includes('ACCEPT')?'accept':'reject'}">${escapeHtml(j.vote||'')}</div><div class="juror-note">${escapeHtml(j.note||'')}</div></div>`).join('');
    return `<div class="verdict-card ${accepted?'accept':'reject'}" data-index="${i}"><div class="verdict-summary"><div class="verdict-name">${escapeHtml(v.playerName)}</div><div class="verdict-vote">JURY ${escapeHtml(v.vote||'')}</div><div class="verdict-state">${v.verdict}</div><div>＋</div></div><div class="verdict-detail"><div class="chair-summary"><strong>CHAIR:</strong> ${escapeHtml(v.summary||'')}</div><div class="juror-grid">${jurors}</div><div class="eyebrow">SUBMITTED PLAN</div><div class="detail-plan">${escapeHtml(v.plan||'')}</div></div></div>`;
  }).join('');
  document.querySelectorAll('.verdict-card').forEach(card=>card.querySelector('.verdict-summary').onclick=()=>card.classList.toggle('open'));
  const roundRanked=[...lobby.verdicts].sort((a,b)=>(b.roundScore||0)-(a.roundScore||0) || String(a.playerName).localeCompare(String(b.playerName)));
  const podium=roundRanked.slice(0,3); const podiumClasses=['first','second','third'];
  $('podium').innerHTML=podium.map((v,i)=>`<div class="podium-place ${podiumClasses[i]}"><div class="podium-rank">${i+1}</div><strong>${escapeHtml(v.playerName)}</strong><span>${v.roundScore||0}/5 JURY PTS</span><small>${escapeHtml(v.verdict)}</small></div>`).join('');
  const overall=[...lobby.players].sort((a,b)=>(b.survived||0)-(a.survived||0) || (b.score||0)-(a.score||0) || (a.failed||0)-(b.failed||0) || String(a.name).localeCompare(String(b.name)));
  $('overallScores').innerHTML=overall.map((p,i)=>`<div class="score-row"><span class="score-rank">${i+1}</span><strong>${escapeHtml(p.name)}</strong><span>${p.survived} SURVIVED</span><span>${p.failed} FAILED</span><b>${p.score||0} PTS</b></div>`).join('');
  $('nextRound').classList.toggle('hidden',!amHost());
  $('nextRound').innerHTML=lobby.gameOver?'START NEW GAME <span>↻</span>':'NEXT ROUND <span>→</span>';
  if(amHost()) $('resultsWaiting').classList.add('hidden');
  else { $('resultsWaiting').classList.remove('hidden'); $('resultsWaiting').textContent=lobby.gameOver?'GAME OVER · WAITING FOR HOST TO START A NEW GAME…':(me()?.active===false?'ELIMINATED · SPECTATING UNTIL THIS GAME ENDS…':'WAITING FOR HOST TO START THE NEXT ROUND…'); }
}

if(lobbyCode && playerToken){ poll(); ensurePolling(); }
