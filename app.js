/* OUT OF HAND — frontend state controller
   Backend is authoritative. This client renders state and sends intents. */

const API_URL = '/api/game';
const POLL_MS = 900;
const API_TIMEOUT_MS = 70000;
const SESSION_TOKEN_KEY = 'ooh_tab_player_token';
const SESSION_LOBBY_KEY = 'ooh_tab_lobby_code';
const DRAFT_PREFIX = 'ooh_draft_';

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];

const state = {
  lobby: null,
  myId: null,
  token: sessionStorage.getItem(SESSION_TOKEN_KEY) || '',
  code: sessionStorage.getItem(SESSION_LOBBY_KEY) || '',
  pollTimer: null,
  clockTimer: null,
  pollInFlight: false,
  judgingInFlight: false,
  action: null,
  connected: navigator.onLine,
  lastPollOk: 0,
  toastTimer: null,
  revealTimer: null,
  readoutTimer: null,
  readoutKey: '',
  revealedJurors: {},
  revealedCards: new Set(),
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function me() { return state.lobby?.players?.find((p) => p.id === state.myId) || null; }
function amHost() { return Boolean(state.lobby && state.lobby.hostPlayerId === state.myId); }

function showScreen(name) {
  for (const screen of screens) screen.classList.toggle('active', screen.id === `screen-${name}`);
  document.body.dataset.screen = name;
}

function ensureGlobalUi() {
  if (!$('connectionBadge')) {
    const badge = document.createElement('div');
    badge.id = 'connectionBadge'; badge.className = 'connection-badge hidden';
    document.body.appendChild(badge);
  }
  if (!$('globalToast')) {
    const toastEl = document.createElement('div');
    toastEl.id = 'globalToast'; toastEl.className = 'global-toast hidden';
    document.body.appendChild(toastEl);
  }
}

function toast(message, kind = 'error', duration = 3800) {
  ensureGlobalUi();
  const el = $('globalToast'); clearTimeout(state.toastTimer);
  el.textContent = message; el.className = `global-toast ${kind}`;
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

function setConnectionStatus(status) {
  ensureGlobalUi(); const badge = $('connectionBadge');
  if (status === 'online') {
    badge.textContent = 'CONNECTED'; badge.className = 'connection-badge online';
    setTimeout(() => { if (state.connected) badge.classList.add('hidden'); }, 1300);
  } else if (status === 'reconnecting') {
    badge.textContent = 'RECONNECTING…'; badge.className = 'connection-badge reconnecting';
  } else {
    badge.textContent = 'OFFLINE'; badge.className = 'connection-badge offline';
  }
}

function persistSession() {
  if (state.token) sessionStorage.setItem(SESSION_TOKEN_KEY, state.token); else sessionStorage.removeItem(SESSION_TOKEN_KEY);
  if (state.code) sessionStorage.setItem(SESSION_LOBBY_KEY, state.code); else sessionStorage.removeItem(SESSION_LOBBY_KEY);
}

function clearSession() {
  state.lobby = null; state.myId = null; state.token = ''; state.code = ''; state.action = null;
  clearTimeout(state.revealTimer); clearTimeout(state.readoutTimer); state.readoutKey=''; state.revealedJurors = {}; state.revealedCards.clear();
  sessionStorage.removeItem(SESSION_TOKEN_KEY); sessionStorage.removeItem(SESSION_LOBBY_KEY);
  stopPolling(); stopClock(); showScreen('home');
}

function draftKey(round = state.lobby?.round) { return `${DRAFT_PREFIX}${state.code}_${round || 0}`; }

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error(`Server returned ${response.status} instead of game data.`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server took too long to respond.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function post(action, payload = {}) {
  return requestJson(API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
}

function adopt(data, { render = true } = {}) {
  if (!data) return;
  if (data.token) state.token = data.token;
  if (data.lobby) {
    const previousState = state.lobby?.state;
    const previousRound = state.lobby?.round;
    state.lobby = data.lobby; state.code = data.lobby.code; state.myId = data.lobby.myPlayerId;
    state.connected = true; state.lastPollOk = Date.now();
    if (previousRound !== data.lobby.round || previousState !== data.lobby.state) {
      if (data.lobby.state === 'scenario') {
        state.revealedJurors = {}; state.revealedCards.clear();
      }
    }
  }
  persistSession(); if (state.lobby) startPolling(); if (render) renderState();
}

async function poll() {
  if (!state.code || !state.token || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await requestJson(`${API_URL}?code=${encodeURIComponent(state.code)}&token=${encodeURIComponent(state.token)}`);
    const wasDisconnected = !state.connected; adopt(data);
    if (wasDisconnected) setConnectionStatus('online');
    maybeTriggerJudging();
  } catch (error) {
    state.connected = false; setConnectionStatus(navigator.onLine ? 'reconnecting' : 'offline');
    if (/Lobby not found/i.test(error.message)) { toast('That lobby no longer exists. Returning home.'); clearSession(); }
  } finally { state.pollInFlight = false; }
}

function startPolling() { if (!state.pollTimer) state.pollTimer = setInterval(poll, POLL_MS); }
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }
function stopClock() { if (state.clockTimer) clearInterval(state.clockTimer); state.clockTimer = null; }

async function maybeTriggerJudging() {
  const lobby = state.lobby;
  if (!lobby || lobby.state !== 'scenario' || state.judgingInFlight) return;
  const allSubmitted = (lobby.connectedCount || 0) > 0 && (lobby.submittedCount || 0) >= (lobby.connectedCount || 0);
  const expired = Boolean(lobby.deadline && Date.now() >= lobby.deadline);
  if (!allSubmitted && !expired) return;
  state.judgingInFlight = true;
  try { adopt(await post('maybeJudge', { code: lobby.code, token: state.token })); }
  catch (error) { console.warn('Judging trigger:', error.message); }
  finally { state.judgingInFlight = false; }
}

function setButtonBusy(button, busy, busyLabel, normalHtml) {
  if (!button) return;
  button.disabled = busy; button.classList.toggle('is-busy', busy);
  button.innerHTML = busy ? `<span class="button-spinner"></span>${escapeHtml(busyLabel)}` : normalHtml;
}

async function startRound() {
  if (!state.lobby || !amHost() || state.action) return;
  state.action = 'start'; renderLobby();
  try { adopt(await post('start', { code: state.lobby.code, token: state.token })); }
  catch (error) { toast(error.message); await poll(); }
  finally { state.action = null; renderState(); }
}

async function submitPlan() {
  if (!state.lobby || state.action || me()?.active === false || me()?.submitted) return;
  const input = $('planInput'); const plan = input.value.trim();
  if (plan.length < 20) { toast('Give the jury a little more than that.'); input.focus(); return; }
  state.action = 'submit'; renderScenario();
  try {
    sessionStorage.removeItem(draftKey());
    adopt(await post('submit', { code: state.lobby.code, token: state.token, plan }));
    maybeTriggerJudging();
  } catch (error) { toast(error.message); }
  finally { state.action = null; renderState(); }
}

function renderState() {
  stopClock();
  if (!state.lobby) return showScreen('home');
  switch (state.lobby.state) {
    case 'lobby': case 'loading': renderLobby(); break;
    case 'scenario': renderScenario(); break;
    case 'judging': renderJudging(); break;
    case 'results': renderResults(); break;
    default: showScreen('lobby'); toast(`Unknown game state: ${state.lobby.state}`);
  }
}

function renderLobby() {
  const lobby = state.lobby; if (!lobby) return; showScreen('lobby');
  const loading = lobby.state === 'loading' || state.action === 'start';
  $('lobbyCode').textContent = lobby.code; $('playerCount').textContent = lobby.players.length;
  $('aiMode').textContent = lobby.aiEnabled ? '● GEMINI JURY ONLINE' : '○ DEMO JURY — ADD GEMINI_API_KEY';
  $('roster').innerHTML = lobby.players.map((player) => {
    const status = player.active === false ? 'ELIMINATED' : loading ? 'LOADING' : 'READY';
    return `<div class="player-row ${player.connected ? '' : 'offline'} ${player.active === false ? 'eliminated' : ''}">
      <span class="dot"></span><span class="name">${escapeHtml(player.name)}</span>
      ${player.isHost ? '<span class="host-tag">HOST</span>' : ''}
      <span class="player-state">${status}</span>
      <span class="stats">${player.score || 0} PTS · ${player.survived || 0} SURVIVED</span>
    </div>`;
  }).join('');

  const start = $('startGame'); const waiting = $('waitingHost');
  start.classList.toggle('hidden', !amHost()); waiting.classList.toggle('hidden', amHost());
  setButtonBusy(start, loading && amHost(), 'LOADING SCENARIO…', 'START ROUND <span>→</span>');
  if (loading) {
    $('lobbyHint').textContent = 'Generating the situation. Hang tight. The server is cooking something terrible.';
  } else {
    $('lobbyHint').textContent = 'Everyone receives the same scenario at the same time. The host starts each round.';
  }
}

function renderScenario() {
  const lobby = state.lobby; const scenario = lobby?.scenario; if (!lobby || !scenario) return;
  showScreen('scenario');
  $('scenarioRound').textContent = `ROUND ${lobby.round}`;
  $('submittedCounter').textContent = `${lobby.submittedCount || 0} / ${lobby.connectedCount || 0} READY`;
  $('scenarioTitle').textContent = scenario.title || 'THE INCIDENT';
  $('scenarioPrompt').textContent = scenario.prompt || '';
  $('scenarioFacts').innerHTML = (scenario.facts || []).map((fact, i) => `<div class="fact"><span class="fact-num">0${i + 1}</span><span>${escapeHtml(fact)}</span></div>`).join('');
  $('scenarioObjective').textContent = scenario.objective || '';
  $('roundModifier').innerHTML = `<span>ROUND MODIFIER</span><strong>${escapeHtml(scenario.modifier?.title || 'STANDARD RULES')}</strong><p>${escapeHtml(scenario.modifier?.description || 'Survive the scenario using the information provided.')}</p>`;

  const player = me(); const eliminated = player?.active === false; const submitted = Boolean(player?.submitted); const submitting = state.action === 'submit';
  const input = $('planInput'); const submitButton = $('submitPlan'); const charCount = $('charCount');
  input.classList.toggle('hidden', eliminated); submitButton.classList.toggle('hidden', eliminated); charCount.classList.toggle('hidden', eliminated);
  if (!submitted && !submitting && !eliminated && input.value === '') input.value = sessionStorage.getItem(draftKey()) || '';

  if (eliminated) {
    $('submitStatus').innerHTML = '<strong>SPECTATING.</strong> You were eliminated. Watch the remaining players try to survive.';
  } else if (submitted) {
    input.disabled = true; submitButton.disabled = true; submitButton.innerHTML = 'PLAN SUBMITTED <span>✓</span>';
    $('submitStatus').textContent = `${lobby.submittedCount || 0} / ${lobby.connectedCount || 0} players ready. Waiting for the rest…`;
  } else if (submitting) {
    input.disabled = true; setButtonBusy(submitButton, true, 'SUBMITTING PLAN…', 'LOCK PLAN <span>✓</span>');
    $('submitStatus').textContent = 'Sending your plan to the game server…';
  } else {
    input.disabled = false; setButtonBusy(submitButton, false, '', 'LOCK PLAN <span>✓</span>');
    $('submitStatus').textContent = 'Once locked, your plan cannot be edited.';
  }

  const tick = () => {
    if (!state.lobby || state.lobby.state !== 'scenario') return;
    const left = Math.max(0, (state.lobby.deadline || Date.now()) - Date.now());
    $('timer').textContent = formatTime(left); $('timer').classList.toggle('danger', left < 30000);
    if (left <= 0) {
      input.disabled = true; submitButton.disabled = true;
      if (!eliminated && !submitted) $('submitStatus').textContent = 'TIME. The jury is reviewing the carnage…';
      maybeTriggerJudging();
    }
  };
  tick(); state.clockTimer = setInterval(tick, 200);
}

function renderJudging() {
  const lobby = state.lobby; showScreen('judging'); $('judgingRound').textContent = `ROUND ${lobby.round}`;
  const progress = lobby.judgingProgress || { done: 0, total: lobby.connectedCount || 0 };
  $('judgeProgressText').textContent = progress.total ? `${progress.done} / ${progress.total} CASES REVIEWED` : 'THE JURY IS REVIEWING THE CASES…';
  $('judgeProgressBar').style.width = progress.total ? `${Math.max(8, (progress.done / progress.total) * 100)}%` : '12%';
  $('judgeStage').textContent = 'Five exhausted jurors are reading every plan. Line by line.';
}

function renderJurorLine(juror, index) {
  const vote = String(juror.vote || '').toUpperCase();
  return `<div class="juror-line ${vote.includes('ACCEPT') ? 'accept' : 'reject'}" data-juror-index="${index}">
    <div class="juror-line-top"><span class="juror-name">${escapeHtml(juror.name || 'JUROR')}</span><span class="juror-vote">${escapeHtml(vote)}</span></div>
    <div class="juror-note">${escapeHtml(juror.note || '')}</div>
  </div>`;
}

function animateVerdict(card, verdict) {
  const key = verdict.playerId;
  if (state.revealedCards.has(key)) return;
  state.revealedCards.add(key);
  const jurors = verdict.jurors || [];
  const container = card.querySelector('.juror-stream');
  const summary = card.querySelector('.ai-summary');
  const verdictBadge = card.querySelector('.stream-verdict');
  const status = card.querySelector('.stream-status');
  container.innerHTML = '';
  summary.classList.add('hidden'); verdictBadge.classList.add('hidden');
  status.textContent = 'READING THE CASE…';
  let i = 0;
  const step = () => {
    if (i < jurors.length) {
      container.insertAdjacentHTML('beforeend', renderJurorLine(jurors[i], i));
      i += 1;
      state.revealTimer = setTimeout(step, 900);
    } else {
      summary.innerHTML = `<strong>CHAIRPERSON:</strong> ${escapeHtml(verdict.summary || 'The jury has reached a decision.')}`;
      summary.classList.remove('hidden');
      verdictBadge.textContent = `${verdict.verdict} · ${verdict.vote || ''}`;
      verdictBadge.classList.remove('hidden');
      status.textContent = 'VERDICT RECORDED';
    }
  };
  step();
}

function playJuryReadout(lobby) {
  const verdicts = lobby.verdicts || [];
  if (!verdicts.length || !$('juryReadout')) return;
  const key = `${lobby.round}:${verdicts.map(v => `${v.playerId}:${v.vote}:${v.verdict}`).join('|')}`;
  if (state.readoutKey === key) return;
  state.readoutKey = key;
  clearTimeout(state.readoutTimer);
  let verdictIndex = 0;
  const title = $('juryReadoutTitle');
  const planEl = $('juryReadoutPlan');
  const linesEl = $('juryReadoutLines');
  const finalEl = $('juryReadoutVerdict');
  const step = () => {
    const verdict = verdicts[verdictIndex];
    if (!verdict) {
      title.textContent = 'THE JURY HAS FINISHED READING.';
      planEl.innerHTML = '';
      linesEl.innerHTML = '<div class="readout-finished">ALL CASES REVIEWED. THE DAMAGE IS NOW OFFICIAL.</div>';
      finalEl.classList.add('hidden');
      return;
    }
    title.textContent = `CASE ${verdictIndex + 1} / ${verdicts.length} · ${String(verdict.playerName || 'PLAYER').toUpperCase()}`;
    const planLines = String(verdict.plan || 'No plan was submitted before time expired.').split(/\r?\n/).filter(Boolean);
    planEl.innerHTML = `<div class="readout-label">SUBMITTED PLAN</div>${planLines.map(line => `<div class="readout-line">${escapeHtml(line)}</div>`).join('')}`;
    linesEl.innerHTML = '';
    finalEl.classList.add('hidden');
    let lineIndex = 0;
    const showLine = () => {
      if (lineIndex < planLines.length) {
        const line = document.createElement('div');
        line.className = 'readout-ai-line plan-line';
        line.textContent = `READING: ${planLines[lineIndex]}`;
        linesEl.appendChild(line);
        lineIndex += 1;
        state.readoutTimer = setTimeout(showLine, 550);
        return;
      }
      const jurors = verdict.jurors || [];
      let jurorIndex = 0;
      const showJuror = () => {
        if (jurorIndex < jurors.length) {
          const j = jurors[jurorIndex];
          const line = document.createElement('div');
          line.className = `readout-ai-line ${String(j.vote).includes('ACCEPT') ? 'accept' : 'reject'}`;
          line.innerHTML = `<strong>${escapeHtml(j.name || 'JUROR')}:</strong> ${escapeHtml(j.note || '')}`;
          linesEl.appendChild(line);
          jurorIndex += 1;
          state.readoutTimer = setTimeout(showJuror, 850);
          return;
        }
        finalEl.textContent = `${verdict.verdict} · JURY ${verdict.vote || ''}`;
        finalEl.classList.remove('hidden');
        state.readoutTimer = setTimeout(() => { verdictIndex += 1; step(); }, 1400);
      };
      showJuror();
    };
    showLine();
  };
  step();
}

function renderResults() {
  const lobby = state.lobby; showScreen('results'); $('resultsRound').textContent = `ROUND ${lobby.round} RESULTS`;
  const ownVerdict = (lobby.verdicts || []).find((v) => v.playerId === state.myId); const player = me();
  if (ownVerdict) {
    const accepted = ownVerdict.verdict === 'ACCEPTED';
    $('myVerdict').className = `my-verdict ${accepted ? 'accept' : 'reject'}`;
    $('myVerdict').innerHTML = `<span class="eyebrow">YOUR VERDICT</span><strong>${escapeHtml(ownVerdict.verdict)}</strong><span>JURY ${escapeHtml(ownVerdict.vote || '')}</span>`;
  } else if (player?.active === false) {
    $('myVerdict').className = 'my-verdict reject'; $('myVerdict').innerHTML = '<span class="eyebrow">YOUR STATUS</span><strong>SPECTATING</strong><span>ELIMINATED EARLIER</span>';
  } else { $('myVerdict').className = 'my-verdict'; $('myVerdict').innerHTML = ''; }

  $('verdictList').innerHTML = (lobby.verdicts || []).map((verdict) => {
    const accepted = verdict.verdict === 'ACCEPTED';
    const jurors = (verdict.jurors || []).map((j) => `<div class="juror"><div class="juror-name">${escapeHtml(j.name || 'JUROR')}</div><div class="juror-vote ${String(j.vote).includes('ACCEPT') ? 'accept' : 'reject'}">${escapeHtml(j.vote || '')}</div><div class="juror-note">${escapeHtml(j.note || '')}</div></div>`).join('');
    return `<div class="verdict-card ${accepted ? 'accept' : 'reject'}">
      <button class="verdict-summary" type="button"><div class="verdict-name">${escapeHtml(verdict.playerName)}</div><div class="verdict-vote">JURY ${escapeHtml(verdict.vote || '')}</div><div class="verdict-state">${escapeHtml(verdict.verdict)}</div><div class="verdict-toggle">＋</div></button>
      <div class="verdict-detail"><div class="chair-summary"><strong>CHAIR:</strong> ${escapeHtml(verdict.summary || '')}</div><div class="juror-grid">${jurors}</div><div class="eyebrow">SUBMITTED PLAN</div><div class="detail-plan">${escapeHtml(verdict.plan || '')}</div></div>
    </div>`;
  }).join('') || '<div class="empty-copy">No verdicts this round.</div>';
  document.querySelectorAll('.verdict-card').forEach((card) => card.querySelector('.verdict-summary')?.addEventListener('click', () => { card.classList.toggle('open'); card.querySelector('.verdict-toggle').textContent = card.classList.contains('open') ? '−' : '＋'; }));
  playJuryReadout(lobby);

  const ranked = [...(lobby.verdicts || [])].sort((a,b) => (b.roundScore||0)-(a.roundScore||0) || String(a.playerName).localeCompare(String(b.playerName)));
  const classes = ['first','second','third'];
  $('podium').innerHTML = ranked.slice(0,3).map((v,i) => `<div class="podium-place ${classes[i]}"><div class="podium-rank">${i+1}</div><strong>${escapeHtml(v.playerName)}</strong><span>${v.roundScore || 0}/5 JURY PTS</span><small>${escapeHtml(v.verdict)}</small></div>`).join('') || '<div class="empty-copy">No verdicts this round.</div>';
  const overall = [...lobby.players].sort((a,b) => (b.score||0)-(a.score||0) || (b.survived||0)-(a.survived||0) || (a.failed||0)-(b.failed||0));
  $('overallScores').innerHTML = overall.map((e,i) => `<div class="score-row ${e.active===false?'eliminated':''}"><span class="score-rank">${i+1}</span><strong>${escapeHtml(e.name)}</strong><span>${e.survived||0} SURVIVED</span><span>${e.failed||0} FAILED</span><b>${e.score||0} PTS</b></div>`).join('');

  const awards = lobby.gameOver ? (lobby.awards || []) : [];
  $('gameAwards').classList.toggle('hidden', awards.length === 0);
  $('gameAwardsList').innerHTML = awards.map((a) => `<div class="award-card"><div class="award-icon">${escapeHtml(a.icon || '🏆')}</div><div><div class="award-title">${escapeHtml(a.title)}</div><strong>${escapeHtml(a.playerName)}</strong><p>${escapeHtml(a.description)}</p></div></div>`).join('');

  const next = $('nextRound'); const host = amHost(); const loading = state.action === 'start';
  next.classList.toggle('hidden', !host); $('resultsWaiting').classList.toggle('hidden', host);
  const label = lobby.gameOver ? 'START NEW GAME <span>↻</span>' : 'NEXT ROUND <span>→</span>';
  setButtonBusy(next, loading, lobby.gameOver ? 'STARTING NEW GAME…' : 'GENERATING SITUATION…', label);
  if (!host) $('resultsWaiting').textContent = lobby.gameOver ? 'GAME OVER · WAITING FOR HOST TO START A NEW GAME…' : player?.active === false ? 'ELIMINATED · SPECTATING…' : 'WAITING FOR HOST TO START THE NEXT ROUND…';
}

function bindEvents() {
  $('hostForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.action) return;
    const name = $('hostName').value.trim(); if (!name) return toast('Enter your name first.');
    state.action = 'create'; const button = $('hostForm').querySelector('button[type="submit"]'); setButtonBusy(button,true,'CREATING LOBBY…','HOST GAME <span>＋</span>');
    try { clearSession(); state.action='create'; adopt(await post('create',{name})); } catch (e) { toast(e.message); }
    finally { state.action=null; setButtonBusy(button,false,'','HOST GAME <span>＋</span>'); }
  });
  $('joinForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.action) return;
    const code=$('joinCode').value.trim().toUpperCase(), name=$('joinName').value.trim(); if(!code||!name) return toast('Enter both the host code and your name.');
    state.action='join'; const button=$('joinForm').querySelector('button[type="submit"]'); setButtonBusy(button,true,'JOINING…','JOIN GAME <span>↗</span>');
    try { clearSession(); state.action='join'; adopt(await post('join',{code,name})); } catch(e){toast(e.message);} finally {state.action=null;setButtonBusy(button,false,'','JOIN GAME <span>↗</span>');}
  });
  $('copyCode').addEventListener('click',async()=>{if(!state.lobby?.code)return;try{await navigator.clipboard.writeText(state.lobby.code);toast('Host code copied.','success',1800);}catch{toast(`Host code: ${state.lobby.code}`,'info');}});
  $('startGame').addEventListener('click',startRound); $('nextRound').addEventListener('click',startRound); $('submitPlan').addEventListener('click',submitPlan);
  $('planInput').addEventListener('input',(e)=>{$('charCount').textContent=`${e.target.value.length} / 5000`;if(state.lobby?.state==='scenario'&&!me()?.submitted)sessionStorage.setItem(draftKey(),e.target.value);});
  window.addEventListener('online',()=>{state.connected=true;setConnectionStatus('reconnecting');poll();});
  window.addEventListener('offline',()=>{state.connected=false;setConnectionStatus('offline');});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.lobby)poll();});
}

async function restoreThisTab() {
  if (!state.code || !state.token) return showScreen('home');
  showScreen('home'); setConnectionStatus('reconnecting');
  try { await poll(); if(state.lobby)setConnectionStatus('online'); } catch { clearSession(); }
}

ensureGlobalUi(); bindEvents(); restoreThisTab();
