/* OUT OF HAND — frontend state controller
   The backend remains authoritative. This client only renders state and sends intents. */

const API_URL = '/api/game';
const POLL_MS = 900;
const API_TIMEOUT_MS = 70000;
const SESSION_TOKEN_KEY = 'ooh_tab_player_token';
const SESSION_LOBBY_KEY = 'ooh_tab_lobby_code';
const DRAFT_PREFIX = 'ooh_draft_';
const SCENARIO_SIGNATURE_KEY = 'ooh_tab_scenario_signature';

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
  currentScenarioRound: null,
  connected: navigator.onLine,
  lastPollOk: 0,
  toastTimer: null,
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

function me() {
  return state.lobby?.players?.find((player) => player.id === state.myId) || null;
}

function amHost() {
  return Boolean(state.lobby && state.lobby.hostPlayerId === state.myId);
}

function showScreen(name) {
  for (const screen of screens) {
    screen.classList.toggle('active', screen.id === `screen-${name}`);
  }
  document.body.dataset.screen = name;
}

function ensureGlobalUi() {
  if (!$('connectionBadge')) {
    const badge = document.createElement('div');
    badge.id = 'connectionBadge';
    badge.className = 'connection-badge hidden';
    document.body.appendChild(badge);
  }

  if (!$('globalToast')) {
    const toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'global-toast hidden';
    document.body.appendChild(toast);
  }
}

function toast(message, kind = 'error', duration = 3800) {
  ensureGlobalUi();
  const element = $('globalToast');
  clearTimeout(state.toastTimer);
  element.textContent = message;
  element.className = `global-toast ${kind}`;
  state.toastTimer = setTimeout(() => element.classList.add('hidden'), duration);
}

function setConnectionStatus(status) {
  ensureGlobalUi();
  const badge = $('connectionBadge');
  if (status === 'online') {
    badge.textContent = 'CONNECTED';
    badge.className = 'connection-badge online';
    setTimeout(() => {
      if (state.connected) badge.classList.add('hidden');
    }, 1300);
  } else if (status === 'reconnecting') {
    badge.textContent = 'RECONNECTING…';
    badge.className = 'connection-badge reconnecting';
  } else {
    badge.textContent = 'OFFLINE';
    badge.className = 'connection-badge offline';
  }
}

function persistSession() {
  if (state.token) sessionStorage.setItem(SESSION_TOKEN_KEY, state.token);
  else sessionStorage.removeItem(SESSION_TOKEN_KEY);

  if (state.code) sessionStorage.setItem(SESSION_LOBBY_KEY, state.code);
  else sessionStorage.removeItem(SESSION_LOBBY_KEY);
}

function clearSession() {
  state.lobby = null;
  state.myId = null;
  state.token = '';
  state.code = '';
  state.currentScenarioRound = null;
  state.action = null;
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_LOBBY_KEY);
  stopPolling();
  stopClock();
  showScreen('home');
}

function draftKey(round = state.lobby?.round) {
  return `${DRAFT_PREFIX}${state.code}_${round || 0}`;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Server returned ${response.status} instead of game data.`);
    }

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The server took too long to respond.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function post(action, payload = {}) {
  return requestJson(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
}

function adopt(data, { render = true } = {}) {
  if (!data) return;

  if (data.token) state.token = data.token;
  if (data.lobby) {
    state.lobby = data.lobby;
    state.code = data.lobby.code;
    state.myId = data.lobby.myPlayerId;
    state.connected = true;
    state.lastPollOk = Date.now();
  }

  persistSession();
  if (state.lobby) startPolling();
  if (render) renderState();
}

async function poll() {
  if (!state.code || !state.token || state.pollInFlight) return;
  state.pollInFlight = true;

  try {
    const data = await requestJson(
      `${API_URL}?code=${encodeURIComponent(state.code)}&token=${encodeURIComponent(state.token)}`
    );
    const wasDisconnected = !state.connected;
    adopt(data);
    if (wasDisconnected) setConnectionStatus('online');
    maybeTriggerJudging();
  } catch (error) {
    state.connected = false;
    setConnectionStatus(navigator.onLine ? 'reconnecting' : 'offline');

    // A 404 after a long-idle Redis lobby should return this tab to home.
    if (/Lobby not found/i.test(error.message)) {
      toast('That lobby no longer exists. Returning home.', 'error');
      clearSession();
    }
  } finally {
    state.pollInFlight = false;
  }
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function stopClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = null;
}

async function maybeTriggerJudging() {
  const lobby = state.lobby;
  if (!lobby || lobby.state !== 'scenario' || state.judgingInFlight) return;

  const allSubmitted = (lobby.connectedCount || 0) > 0 &&
    (lobby.submittedCount || 0) >= (lobby.connectedCount || 0);
  const expired = Boolean(lobby.deadline && Date.now() >= lobby.deadline);
  if (!allSubmitted && !expired) return;

  state.judgingInFlight = true;
  try {
    const data = await post('maybeJudge', { code: lobby.code, token: state.token });
    adopt(data);
  } catch (error) {
    // Another client may have won the race and started judging first. Polling will recover state.
    console.warn('Judging trigger:', error.message);
  } finally {
    state.judgingInFlight = false;
  }
}

function setButtonBusy(button, busy, busyLabel, normalHtml) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  button.innerHTML = busy ? `<span class="button-spinner"></span>${escapeHtml(busyLabel)}` : normalHtml;
}

async function startRound() {
  if (!state.lobby || !amHost() || state.action) return;

  state.action = 'start';
  renderLobby();

  try {
    const data = await post('start', { code: state.lobby.code, token: state.token });
    adopt(data);
  } catch (error) {
    toast(error.message);
    // Poll once before restoring the button. The backend may have accepted the start
    // even if this particular request lost its response.
    await poll();
  } finally {
    state.action = null;
    renderState();
  }
}

async function submitPlan() {
  if (!state.lobby || state.action || me()?.active === false || me()?.submitted) return;

  const input = $('planInput');
  const plan = input.value.trim();
  if (plan.length < 20) {
    toast('Give the jury a little more than that.');
    input.focus();
    return;
  }

  state.action = 'submit';
  renderScenario();

  try {
    const data = await post('submit', {
      code: state.lobby.code,
      token: state.token,
      plan,
    });
    sessionStorage.removeItem(draftKey());
    adopt(data);
    maybeTriggerJudging();
  } catch (error) {
    toast(error.message);
  } finally {
    state.action = null;
    renderState();
  }
}

function renderState() {
  stopClock();

  if (!state.lobby) {
    showScreen('home');
    return;
  }

  switch (state.lobby.state) {
    case 'lobby':
    case 'loading':
      renderLobby();
      break;
    case 'scenario':
      renderScenario();
      break;
    case 'judging':
      renderJudging();
      break;
    case 'results':
      renderResults();
      break;
    default:
      showScreen('lobby');
      toast(`Unknown game state: ${state.lobby.state}`);
  }
}

function renderLobby() {
  const lobby = state.lobby;
  if (!lobby) return;
  showScreen('lobby');

  const loading = lobby.state === 'loading' || state.action === 'start';
  const host = amHost();
  const startButton = $('startGame');

  $('lobbyCode').textContent = lobby.code;
  $('playerCount').textContent = lobby.players.length;
  $('aiMode').textContent = lobby.aiEnabled ? '● GEMINI JURY ONLINE' : '○ DEMO JURY — ADD GEMINI_API_KEY';

  $('roster').innerHTML = lobby.players.map((player) => {
    const status = player.active === false ? 'ELIMINATED' : loading ? 'WAITING' : 'READY';
    return `
      <div class="player-row ${player.connected ? '' : 'offline'} ${player.active === false ? 'eliminated' : ''}">
        <span class="dot"></span>
        <span class="name">${escapeHtml(player.name)}</span>
        ${player.isHost ? '<span class="host-tag">HOST</span>' : ''}
        <span class="player-state">${status}</span>
        <span class="stats">${player.score || 0} PTS · ${player.survived || 0} SURVIVED</span>
      </div>`;
  }).join('');

  startButton.classList.toggle('hidden', !host);
  $('waitingHost').classList.toggle('hidden', host);

  const normalLabel = lobby.round > 0
    ? 'START NEXT ROUND <span>→</span>'
    : 'START ROUND <span>→</span>';
  setButtonBusy(startButton, loading, 'GENERATING SITUATION…', normalLabel);

  if (loading) {
    $('waitingHost').classList.remove('hidden');
    $('waitingHost').innerHTML = '<span class="inline-spinner"></span> GEMINI IS PREPARING THE NEXT SITUATION…';
    startButton.classList.toggle('hidden', !host);
  } else if (!host) {
    $('waitingHost').textContent = 'WAITING FOR HOST…';
  }
}

function prepareScenarioInput() {
  const round = state.lobby.round;
  const input = $('planInput');
  const scenario = state.lobby.scenario || {};
  const signature = `${state.code}|${round}|${scenario.title || ''}|${scenario.prompt || ''}`;
  const previousSignature = sessionStorage.getItem(SCENARIO_SIGNATURE_KEY) || '';
  const changedScenario = previousSignature !== signature;

  if (changedScenario) {
    // Different prompt = guaranteed blank field, even if a new game reuses Round 1.
    input.value = '';
    sessionStorage.removeItem(draftKey(round));
    sessionStorage.setItem(SCENARIO_SIGNATURE_KEY, signature);
  } else if (state.currentScenarioRound !== round) {
    // Same prompt after a refresh in this tab: recover the unfinished draft.
    input.value = sessionStorage.getItem(draftKey(round)) || '';
  }

  state.currentScenarioRound = round;
  $('charCount').textContent = `${input.value.length} / 5000`;
}

function renderScenario() {
  const lobby = state.lobby;
  if (!lobby?.scenario) return;
  showScreen('scenario');
  prepareScenarioInput();

  $('scenarioRound').textContent = `ROUND ${lobby.round}`;
  $('scenarioTitle').textContent = lobby.scenario.title;
  $('scenarioPrompt').textContent = lobby.scenario.prompt;
  $('scenarioFacts').innerHTML = (lobby.scenario.facts || []).map((fact, index) => `
    <div class="fact"><span class="fact-num">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(fact)}</span></div>
  `).join('');
  $('scenarioObjective').textContent = lobby.scenario.objective;
  $('submittedCounter').textContent = `${lobby.submittedCount || 0} / ${lobby.connectedCount || 0} READY`;

  const player = me();
  const eliminated = player?.active === false;
  const submitted = Boolean(player?.submitted);
  const submitting = state.action === 'submit';
  const input = $('planInput');
  const submitButton = $('submitPlan');
  const charCount = $('charCount');

  input.classList.toggle('hidden', eliminated);
  submitButton.classList.toggle('hidden', eliminated);
  charCount.classList.toggle('hidden', eliminated);

  if (eliminated) {
    $('submitStatus').innerHTML = `<strong>SPECTATING.</strong> You were eliminated earlier. ${lobby.connectedCount || 0} competitor${(lobby.connectedCount || 0) === 1 ? '' : 's'} remain.`;
  } else if (submitted) {
    input.disabled = true;
    submitButton.disabled = true;
    submitButton.innerHTML = 'PLAN SUBMITTED <span>✓</span>';
    $('submitStatus').textContent = `${lobby.submittedCount || 0} / ${lobby.connectedCount || 0} players ready. Waiting for the rest…`;
  } else if (submitting) {
    input.disabled = true;
    setButtonBusy(submitButton, true, 'SUBMITTING PLAN…', 'LOCK PLAN <span>✓</span>');
    $('submitStatus').textContent = 'Sending your plan to the game server…';
  } else {
    input.disabled = false;
    setButtonBusy(submitButton, false, '', 'LOCK PLAN <span>✓</span>');
    $('submitStatus').textContent = 'Your answer cannot be edited after submission.';
  }

  const tick = () => {
    if (!state.lobby || state.lobby.state !== 'scenario') return;
    const left = Math.max(0, (state.lobby.deadline || Date.now()) - Date.now());
    $('timer').textContent = formatTime(left);
    $('timer').classList.toggle('danger', left < 30000);

    if (left <= 0) {
      input.disabled = true;
      submitButton.disabled = true;
      if (!eliminated && !submitted) $('submitStatus').textContent = 'TIME. Waiting for the jury…';
      maybeTriggerJudging();
    }
  };

  tick();
  state.clockTimer = setInterval(tick, 200);
}

function renderJudging() {
  const lobby = state.lobby;
  showScreen('judging');
  $('judgingRound').textContent = `ROUND ${lobby.round}`;

  const progress = lobby.judgingProgress || { done: 0, total: lobby.connectedCount || 0 };
  $('judgeProgressText').textContent = progress.total
    ? `${progress.done} / ${progress.total} CASES REVIEWED`
    : 'THE JURY IS REVIEWING THE CASES…';
  $('judgeProgressBar').style.width = progress.total
    ? `${Math.max(8, (progress.done / progress.total) * 100)}%`
    : '12%';
}

function renderResults() {
  const lobby = state.lobby;
  showScreen('results');
  $('resultsRound').textContent = `ROUND ${lobby.round} RESULTS`;

  const ownVerdict = (lobby.verdicts || []).find((verdict) => verdict.playerId === state.myId);
  const player = me();

  if (ownVerdict) {
    const accepted = ownVerdict.verdict === 'ACCEPTED';
    $('myVerdict').className = `my-verdict ${accepted ? 'accept' : 'reject'}`;
    $('myVerdict').innerHTML = `
      <span class="eyebrow">YOUR VERDICT</span>
      <strong>${escapeHtml(ownVerdict.verdict)}</strong>
      <span>JURY ${escapeHtml(ownVerdict.vote || '')}</span>`;
  } else if (player?.active === false) {
    $('myVerdict').className = 'my-verdict reject';
    $('myVerdict').innerHTML = '<span class="eyebrow">YOUR STATUS</span><strong>SPECTATING</strong><span>ELIMINATED IN AN EARLIER ROUND</span>';
  } else {
    $('myVerdict').className = 'my-verdict';
    $('myVerdict').innerHTML = '';
  }

  $('verdictList').innerHTML = (lobby.verdicts || []).map((verdict) => {
    const accepted = verdict.verdict === 'ACCEPTED';
    const jurors = (verdict.jurors || []).map((juror) => `
      <div class="juror">
        <div class="juror-name">${escapeHtml(juror.name || 'JUROR')}</div>
        <div class="juror-vote ${String(juror.vote).includes('ACCEPT') ? 'accept' : 'reject'}">${escapeHtml(juror.vote || '')}</div>
        <div class="juror-note">${escapeHtml(juror.note || '')}</div>
      </div>`).join('');

    return `
      <div class="verdict-card ${accepted ? 'accept' : 'reject'}">
        <button class="verdict-summary" type="button">
          <div class="verdict-name">${escapeHtml(verdict.playerName)}</div>
          <div class="verdict-vote">JURY ${escapeHtml(verdict.vote || '')}</div>
          <div class="verdict-state">${escapeHtml(verdict.verdict)}</div>
          <div class="verdict-toggle">＋</div>
        </button>
        <div class="verdict-detail">
          <div class="chair-summary"><strong>CHAIR:</strong> ${escapeHtml(verdict.summary || '')}</div>
          <div class="juror-grid">${jurors}</div>
          <div class="eyebrow">SUBMITTED PLAN</div>
          <div class="detail-plan">${escapeHtml(verdict.plan || '')}</div>
        </div>
      </div>`;
  }).join('');

  document.querySelectorAll('.verdict-card').forEach((card) => {
    const summary = card.querySelector('.verdict-summary');
    summary.addEventListener('click', () => {
      card.classList.toggle('open');
      card.querySelector('.verdict-toggle').textContent = card.classList.contains('open') ? '−' : '＋';
    });
  });

  const roundRanked = [...(lobby.verdicts || [])].sort((a, b) =>
    (b.roundScore || 0) - (a.roundScore || 0) || String(a.playerName).localeCompare(String(b.playerName))
  );
  const podiumClasses = ['first', 'second', 'third'];
  $('podium').innerHTML = roundRanked.slice(0, 3).map((verdict, index) => `
    <div class="podium-place ${podiumClasses[index]}">
      <div class="podium-rank">${index + 1}</div>
      <strong>${escapeHtml(verdict.playerName)}</strong>
      <span>${verdict.roundScore || 0}/5 JURY PTS</span>
      <small>${escapeHtml(verdict.verdict)}</small>
    </div>`).join('') || '<div class="empty-copy">No verdicts this round.</div>';

  const overall = [...lobby.players].sort((a, b) =>
    (b.survived || 0) - (a.survived || 0) ||
    (b.score || 0) - (a.score || 0) ||
    (a.failed || 0) - (b.failed || 0) ||
    String(a.name).localeCompare(String(b.name))
  );
  $('overallScores').innerHTML = overall.map((entry, index) => `
    <div class="score-row ${entry.active === false ? 'eliminated' : ''}">
      <span class="score-rank">${index + 1}</span>
      <strong>${escapeHtml(entry.name)}</strong>
      <span>${entry.survived || 0} SURVIVED</span>
      <span>${entry.failed || 0} FAILED</span>
      <b>${entry.score || 0} PTS</b>
    </div>`).join('');

  const nextButton = $('nextRound');
  const host = amHost();
  const loading = state.action === 'start';
  nextButton.classList.toggle('hidden', !host);
  $('resultsWaiting').classList.toggle('hidden', host);

  const normalLabel = lobby.gameOver
    ? 'START NEW GAME <span>↻</span>'
    : 'NEXT ROUND <span>→</span>';
  setButtonBusy(nextButton, loading, lobby.gameOver ? 'STARTING NEW GAME…' : 'GENERATING SITUATION…', normalLabel);

  if (!host) {
    $('resultsWaiting').textContent = lobby.gameOver
      ? 'GAME OVER · WAITING FOR HOST TO START A NEW GAME…'
      : player?.active === false
        ? 'ELIMINATED · SPECTATING UNTIL THIS GAME ENDS…'
        : 'WAITING FOR HOST TO START THE NEXT ROUND…';
  }
}

function bindEvents() {
  $('hostForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.action) return;

    const name = $('hostName').value.trim();
    if (!name) return toast('Enter your name first.');

    state.action = 'create';
    const button = $('hostForm').querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'CREATING LOBBY…', 'HOST GAME <span>＋</span>');

    try {
      clearSession();
      state.action = 'create';
      const data = await post('create', { name });
      adopt(data);
    } catch (error) {
      toast(error.message);
    } finally {
      state.action = null;
      setButtonBusy(button, false, '', 'HOST GAME <span>＋</span>');
    }
  });

  $('joinForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.action) return;

    const code = $('joinCode').value.trim().toUpperCase();
    const name = $('joinName').value.trim();
    if (!code || !name) return toast('Enter both the host code and your name.');

    state.action = 'join';
    const button = $('joinForm').querySelector('button[type="submit"]');
    setButtonBusy(button, true, 'JOINING…', 'JOIN GAME <span>↗</span>');

    try {
      clearSession();
      state.action = 'join';
      const data = await post('join', { code, name });
      adopt(data);
    } catch (error) {
      toast(error.message);
    } finally {
      state.action = null;
      setButtonBusy(button, false, '', 'JOIN GAME <span>↗</span>');
    }
  });

  $('copyCode').addEventListener('click', async () => {
    if (!state.lobby?.code) return;
    try {
      await navigator.clipboard.writeText(state.lobby.code);
      toast('Host code copied.', 'success', 1800);
    } catch {
      toast(`Host code: ${state.lobby.code}`, 'info');
    }
  });

  $('startGame').addEventListener('click', startRound);
  $('nextRound').addEventListener('click', startRound);
  $('submitPlan').addEventListener('click', submitPlan);

  $('planInput').addEventListener('input', (event) => {
    $('charCount').textContent = `${event.target.value.length} / 5000`;
    if (state.lobby?.state === 'scenario' && !me()?.submitted) {
      sessionStorage.setItem(draftKey(), event.target.value);
    }
  });

  window.addEventListener('online', () => {
    state.connected = true;
    setConnectionStatus('reconnecting');
    poll();
  });

  window.addEventListener('offline', () => {
    state.connected = false;
    setConnectionStatus('offline');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.lobby) poll();
  });
}

async function restoreThisTab() {
  if (!state.code || !state.token) {
    showScreen('home');
    return;
  }

  // sessionStorage means refreshes reconnect, while a normal fresh tab starts clean.
  showScreen('home');
  setConnectionStatus('reconnecting');

  try {
    await poll();
    if (state.lobby) setConnectionStatus('online');
  } catch {
    clearSession();
  }
}

ensureGlobalUi();
bindEvents();
restoreThisTab();
