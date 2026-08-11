import { Redis } from '@upstash/redis';
import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';

export const maxDuration = 60;

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAN_TIME_MS = 180000;
const LOBBY_TTL_SECONDS = 21600;

const keyFor = code => `ooh:lobby:${code}`;
const lockKeyFor = code => `ooh:lock:${code}`;

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function cleanName(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
}

function makeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function makePlayerId() {
  return crypto.randomUUID();
}

async function makeCode() {
  for (let tries = 0; tries < 80; tries++) {
    let code = '';

    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[
        Math.floor(Math.random() * CODE_CHARS.length)
      ];
    }

    if (!(await redis.exists(keyFor(code)))) {
      return code;
    }
  }

  return crypto
    .randomBytes(4)
    .toString('hex')
    .slice(0, 6)
    .toUpperCase();
}

async function getLobby(code) {
  if (!code) return null;

  return await redis.get(keyFor(code));
}

async function saveLobby(lobby) {
  lobby.updatedAt = Date.now();

  await redis.set(
    keyFor(lobby.code),
    lobby,
    {
      ex: LOBBY_TTL_SECONDS
    }
  );
}

async function withLock(code, fn) {
  const lk = lockKeyFor(code);
  const token = crypto.randomUUID();

  for (let i = 0; i < 30; i++) {
    const ok = await redis.set(
      lk,
      token,
      {
        nx: true,
        px: 5000
      }
    );

    if (ok) {
      try {
        return await fn();
      } finally {
        const current = await redis.get(lk);

        if (current === token) {
          await redis.del(lk);
        }
      }
    }

    await new Promise(resolve =>
      setTimeout(resolve, 40 + i * 8)
    );
  }

  throw new Error('Lobby is busy. Try again.');
}

function findPlayerByToken(lobby, token) {
  return (
    lobby?.players?.find(
      player => player.token === token
    ) || null
  );
}

function publicLobby(lobby, token) {
  const me = findPlayerByToken(lobby, token);

  const activeConnected = lobby.players.filter(
    player =>
      player.connected !== false &&
      player.active !== false
  );

  return {
    code: lobby.code,
    state: lobby.state,
    round: lobby.round,
    hostPlayerId: lobby.hostPlayerId,
    myPlayerId: me?.id || null,

    players: lobby.players.map(player => ({
      id: player.id,
      name: player.name,
      isHost: player.id === lobby.hostPlayerId,
      submitted: Boolean(player.plan),
      active: player.active !== false,
      connected: player.connected !== false,
      survived: player.survived || 0,
      failed: player.failed || 0,
      streak: player.streak || 0,
      score: player.score || 0
    })),

    scenario: [
      'scenario',
      'judging',
      'results'
    ].includes(lobby.state)
      ? lobby.scenario
      : null,

    deadline: lobby.deadline || null,

    verdicts:
      lobby.state === 'results'
        ? lobby.verdicts || []
        : [],

    judgingProgress:
      lobby.judgingProgress || null,

    submittedCount:
      activeConnected.filter(
        player => Boolean(player.plan)
      ).length,

    connectedCount:
      activeConnected.length,

    spectatorCount:
      lobby.players.filter(
        player =>
          player.connected !== false &&
          player.active === false
      ).length,

    gameOver: Boolean(lobby.gameOver),

    aiEnabled: Boolean(ai)
  };
}

function fallbackScenario(round) {
  const scenarios = [
    {
      title: 'THE COLLAPSING TRAIN',

      prompt:
        'You are inside the rear carriage of a commuter train stopped halfway across a damaged bridge. The front carriages have begun slipping over the edge. The bridge deck is cracking toward you. You have 6 minutes before engineers estimate the section beneath your carriage may fail.',

      facts: [
        'The carriage doors still work manually.',
        'The nearest stable end of the bridge is about 90 meters behind you.',
        'There are 12 other passengers, some panicking but mobile.',
        'You have your normal clothes, a phone with 18% battery, and a small backpack.',
        'There is no guarantee emergency crews arrive within 6 minutes.'
      ],

      objective:
        'Give a realistic plan that keeps you alive through the next 15 minutes.'
    },

    {
      title: 'THE FLOODED MALL',

      prompt:
        'A flash flood has entered a two-story shopping mall after closing. Water on the first floor is already waist-deep and rising quickly. Power is flickering, and most exterior doors are locked by an electronic security system.',

      facts: [
        'You are near an escalator to the second floor.',
        'Water is rising roughly 20 cm per minute.',
        'You have a phone, jacket, metal water bottle, and multitool.',
        'There are skylights above the central atrium.',
        'You cannot assume a rescue helicopter is already coming.'
      ],

      objective:
        'Explain how you would maximize your chance of surviving until rescuers can reach the building.'
    }
  ];

  return scenarios[
    (round - 1) % scenarios.length
  ];
}

async function generateScenario(round) {
  if (!ai) {
    return fallbackScenario(round);
  }

  const prompt = `
Create one tense but realistically survivable disaster scenario
for round ${round} of a browser party game called OUT OF HAND.

Players must independently explain how they survive.

Difficulty should increase gradually with the round,
but the scenario must never require illegal, violent,
or harmful instructions against other people.

Avoid scenarios where success depends on obscure trivia.

Return ONLY valid JSON with this exact shape:

{
  "title":"short uppercase title",
  "prompt":"2-4 sentence situation",
  "facts":[
    "fact 1",
    "fact 2",
    "fact 3",
    "fact 4",
    "fact 5"
  ],
  "objective":"one sentence survival objective"
}

Every crucial constraint needed to judge a plan must be
explicitly stated.

Do not invent hidden exits or required actions.
`;

  try {
    const response =
      await ai.models.generateContent({
        model: MODEL,

        contents: prompt,

        config: {
          responseMimeType:
            'application/json',

          temperature: 1.0
        }
      });

    const parsed =
      JSON.parse(response.text);

    if (
      !parsed?.title ||
      !parsed?.prompt ||
      !Array.isArray(parsed?.facts)
    ) {
      throw new Error(
        'Bad scenario JSON'
      );
    }

    return parsed;
  } catch (error) {
    console.error(
      'Scenario generation failed:',
      error.message
    );

    return fallbackScenario(round);
  }
}

function fallbackVerdict(player) {
  const accepted =
    (player.plan || '')
      .trim()
      .length >= 120;

  return {
    playerId: player.id,
    playerName: player.name,

    verdict:
      accepted
        ? 'ACCEPTED'
        : 'REJECTED',

    vote:
      accepted
        ? '4-1'
        : '1-4',

    jurors: [
      {
        name: 'LOGIC',
        vote:
          accepted
            ? 'ACCEPT'
            : 'REJECT',

        note:
          accepted
            ? 'The plan has enough concrete steps to evaluate.'
            : 'The plan is too vague to establish a feasible survival path.'
      },

      {
        name: 'REALISM',
        vote:
          accepted
            ? 'ACCEPT'
            : 'REJECT',

        note:
          accepted
            ? 'No obvious impossible assumption dominates the plan.'
            : 'Key actions are unsupported or unexplained.'
      },

      {
        name: 'RESOURCES',
        vote:
          accepted
            ? 'ACCEPT'
            : 'REJECT',

        note:
          accepted
            ? 'The response appears to work within the listed resources.'
            : 'The response does not clearly account for the listed constraints.'
      },

      {
        name: 'SURVIVAL',
        vote:
          accepted
            ? 'ACCEPT'
            : 'REJECT',

        note:
          accepted
            ? 'The actions generally reduce immediate risk.'
            : 'The response does not sufficiently address the immediate danger.'
      },

      {
        name: 'SKEPTIC',
        vote: 'REJECT',
        note:
          'Demo mode remains suspicious of everybody.'
      }
    ],

    summary:
      'Demo verdict because GEMINI_API_KEY is not configured.',

    plan:
      player.plan ||
      'No plan was submitted before time expired.'
  };
}

async function judgeAll(
  scenario,
  contestants
) {
  if (!ai) {
    return contestants.map(
      fallbackVerdict
    );
  }

  const submissions =
    contestants.map(player => ({
      playerId: player.id,
      playerName: player.name,

      plan:
        (player.plan || '').trim() ||
        'No plan was submitted before time expired.'
    }));

  const prompt = `
You are a five-member jury judging survival plans
in a party game.

Be strict but fair.

Judge ONLY against facts stated in the scenario
and ordinary common knowledge.

Do not reject a plan because it failed to use an
option that the scenario never established.

Do not reward magical luck, impossible physics,
unexplained equipment, or assuming guaranteed rescue.

A plan can be imperfect and still pass if it gives
a plausible path to survival.

SCENARIO:
${JSON.stringify(scenario)}

SUBMISSIONS:
${JSON.stringify(submissions)}

Return ONLY valid JSON with this exact structure:

{
  "verdicts":[
    {
      "playerId":"copy exact playerId",
      "playerName":"copy player name",
      "verdict":"ACCEPTED or REJECTED",
      "vote":"for example 4-1",

      "jurors":[
        {
          "name":"LOGIC",
          "vote":"ACCEPT or REJECT",
          "note":"brief finding"
        },
        {
          "name":"REALISM",
          "vote":"ACCEPT or REJECT",
          "note":"brief finding"
        },
        {
          "name":"RESOURCES",
          "vote":"ACCEPT or REJECT",
          "note":"brief finding"
        },
        {
          "name":"SURVIVAL",
          "vote":"ACCEPT or REJECT",
          "note":"brief finding"
        },
        {
          "name":"SKEPTIC",
          "vote":"ACCEPT or REJECT",
          "note":"brief finding"
        }
      ],

      "summary":
        "2-3 sentence chairperson explanation"
    }
  ]
}

Judge every submission independently.

The majority juror vote must match each verdict.

Keep notes concise.
`;

  try {
    const response =
      await ai.models.generateContent({
        model: MODEL,

        contents: prompt,

        config: {
          responseMimeType:
            'application/json',

          temperature: 0.25
        }
      });

    const data =
      JSON.parse(response.text);

    const byId =
      new Map(
        (data.verdicts || []).map(
          verdict => [
            verdict.playerId,
            verdict
          ]
        )
      );

    return contestants.map(player => {
      const raw =
        byId.get(player.id);

      if (!raw) {
        return fallbackVerdict(
          player
        );
      }

      const verdict =
        String(raw.verdict)
          .toUpperCase() ===
        'ACCEPTED'
          ? 'ACCEPTED'
          : 'REJECTED';

      return {
        ...raw,

        playerId:
          player.id,

        playerName:
          player.name,

        verdict,

        plan:
          (player.plan || '')
            .trim() ||
          'No plan was submitted before time expired.'
      };
    });
  } catch (error) {
    console.error(
      'Batch judging failed:',
      error.message
    );

    return contestants.map(
      player => ({
        ...fallbackVerdict(player),

        verdict:
          'ACCEPTED',

        vote:
          '3-2',

        summary:
          'The AI jury failed to return a usable verdict, so the player receives the benefit of the doubt.'
      })
    );
  }
}

async function actionCreate(name) {
  const clean =
    cleanName(name);

  if (!clean) {
    throw new Error(
      'Enter a name.'
    );
  }

  const code =
    await makeCode();

  const token =
    makeToken();

  const id =
    makePlayerId();

  const player = {
    id,
    token,
    name: clean,

    connected: true,
    active: true,

    plan: '',

    survived: 0,
    failed: 0,
    streak: 0,
    score: 0
  };

  const lobby = {
    code,

    hostPlayerId:
      id,

    players: [
      player
    ],

    round: 0,
    state: 'lobby',

    scenario: null,
    verdicts: [],

    gameOver: false,

    deadline: null,

    judgingProgress:
      null,

    createdAt:
      Date.now()
  };

  await saveLobby(lobby);

  return {
    token,

    lobby:
      publicLobby(
        lobby,
        token
      )
  };
}

async function actionJoin(
  code,
  name
) {
  const cleanCode =
    String(code || '')
      .trim()
      .toUpperCase();

  const clean =
    cleanName(name);

  if (!clean) {
    throw new Error(
      'Enter a name.'
    );
  }

  const token =
    makeToken();

  return await withLock(
    cleanCode,

    async () => {
      const lobby =
        await getLobby(
          cleanCode
        );

      if (!lobby) {
        throw new Error(
          'That host code does not exist.'
        );
      }

      if (
        lobby.state !==
        'lobby'
      ) {
        throw new Error(
          'That game has already started.'
        );
      }

      if (
        lobby.players.some(
          player =>
            player.name
              .toLowerCase() ===
            clean.toLowerCase()
        )
      ) {
        throw new Error(
          'That name is already in this lobby.'
        );
      }

      const id =
        makePlayerId();

      lobby.players.push({
        id,
        token,

        name: clean,

        connected: true,
        active: true,

        plan: '',

        survived: 0,
        failed: 0,
        streak: 0,
        score: 0
      });

      await saveLobby(
        lobby
      );

      return {
        token,

        lobby:
          publicLobby(
            lobby,
            token
          )
      };
    }
  );
}

async function actionStart(
  code,
  token
) {
  const cleanCode =
    String(code || '')
      .trim()
      .toUpperCase();

  let round;

  await withLock(
    cleanCode,

    async () => {
      const lobby =
        await getLobby(
          cleanCode
        );

      const player =
        findPlayerByToken(
          lobby,
          token
        );

      if (
        !lobby ||
        !player ||
        player.id !==
          lobby.hostPlayerId
      ) {
        throw new Error(
          'Only the host can start.'
        );
      }

      if (
        ![
          'lobby',
          'results'
        ].includes(
          lobby.state
        )
      ) {
        throw new Error(
          'A round is already running.'
        );
      }

      if (
        lobby.state ===
          'results' &&
        lobby.gameOver
      ) {
        lobby.round = 0;

        lobby.gameOver =
          false;

        lobby.scenario =
          null;

        lobby.verdicts =
          [];

        lobby.deadline =
          null;

        lobby.players.forEach(
          player => {
            player.plan = '';
            player.active = true;
            player.survived = 0;
            player.failed = 0;
            player.streak = 0;
            player.score = 0;
          }
        );
      }

      if (
        !lobby.players.some(
          player =>
            player.connected !==
              false &&
            player.active !==
              false
        )
      ) {
        throw new Error(
          'No active players remain. Start a new game.'
        );
      }

      lobby.round += 1;

      round =
        lobby.round;

      lobby.state =
        'loading';

      lobby.scenario =
        null;

      lobby.verdicts =
        [];

      lobby.deadline =
        null;

      lobby.judgingProgress =
        null;

      lobby.players.forEach(
        player => {
          player.plan = '';
        }
      );

      await saveLobby(
        lobby
      );
    }
  );

  const scenario =
    await generateScenario(
      round
    );

  return await withLock(
    cleanCode,

    async () => {
      const lobby =
        await getLobby(
          cleanCode
        );

      if (
        !lobby ||
        lobby.state !==
          'loading' ||
        lobby.round !==
          round
      ) {
        throw new Error(
          'Round state changed while loading.'
        );
      }

      lobby.scenario =
        scenario;

      lobby.state =
        'scenario';

      lobby.deadline =
        Date.now() +
        PLAN_TIME_MS;

      await saveLobby(
        lobby
      );

      return publicLobby(
        lobby,
        token
      );
    }
  );
}

async function actionSubmit(
  code,
  token,
  plan
) {
  const cleanCode =
    String(code || '')
      .trim()
      .toUpperCase();

  return await withLock(
    cleanCode,

    async () => {
      const lobby =
        await getLobby(
          cleanCode
        );

      const player =
        findPlayerByToken(
          lobby,
          token
        );

      if (
        !lobby ||
        !player ||
        lobby.state !==
          'scenario'
      ) {
        throw new Error(
          'Plans are not being accepted right now.'
        );
      }

      if (
        player.active ===
        false
      ) {
        throw new Error(
          'You were eliminated and are spectating this game.'
        );
      }

      const cleanPlan =
        String(plan || '')
          .trim()
          .slice(
            0,
            5000
          );

      if (
        cleanPlan.length <
        20
      ) {
        throw new Error(
          'Give the jury a little more than that.'
        );
      }

      if (player.plan) {
        throw new Error(
          'Your plan is already locked.'
        );
      }

      player.plan =
        cleanPlan;

      await saveLobby(
        lobby
      );

      return publicLobby(
        lobby,
        token
      );
    }
  );
}

async function actionMaybeJudge(
  code,
  token
) {
  const cleanCode =
    String(code || '')
      .trim()
      .toUpperCase();

  let snapshot = null;

  await withLock(
    cleanCode,

    async () => {
      const lobby =
        await getLobby(
          cleanCode
        );

      if (!lobby) {
        throw new Error(
          'Lobby not found.'
        );
      }

      if (
        lobby.state !==
        'scenario'
      ) {
        return;
      }

      const contestants =
        lobby.players.filter(
          player =>
            player.connected !==
              false &&
            player.active !==
              false
        );

      const allSubmitted =
        contestants.length >
          0 &&
        contestants.every(
          player =>
            Boolean(
              player.plan
            )
        );

      const expired =
        lobby.deadline &&
        Date.now() >=
          lobby.deadline;

      if (
        !allSubmitted &&
        !expired
      ) {
        return;
      }

      lobby.state =
        'judging';

      lobby.deadline =
        null;

      lobby.judgingProgress =
        {
          done: 0,
          total:
            contestants.length
        };

      snapshot = {
        round:
          lobby.round,

        scenario:
          lobby.scenario,

        contestants:
          contestants.map(
            player => ({
              ...player
            })
          )
      };

      await saveLobby(
        lobby
      );
    }
  );

  if (!snapshot) {
    const lobby =
      await getLobby(
        cleanCode
      );

    return publicLobby(
      lobby,
      token
    );
  }

  const verdicts =
    await judgeAll(
      snapshot.scenario,
      snapshot.contestants
    );

  return await withLock(
    cleanCode,

    async () => {
      const lobby =
        await getLobby(
          cleanCode
        );

      if (
        !lobby ||
        lobby.state !==
          'judging' ||
        lobby.round !==
          snapshot.round
      ) {
        return publicLobby(
          lobby,
          token
        );
      }

      for (
        const verdict
        of verdicts
      ) {
        const player =
          lobby.players.find(
            player =>
              player.id ===
              verdict.playerId
          );

        if (!player) {
          continue;
        }

        const acceptVotes =
          (
            verdict.jurors ||
            []
          ).filter(
            juror =>
              String(
                juror.vote ||
                  ''
              )
                .toUpperCase()
                .includes(
                  'ACCEPT'
                )
          ).length;

        verdict.roundScore =
          acceptVotes;

        player.score =
          (player.score || 0) +
          acceptVotes;

        if (
          verdict.verdict ===
          'ACCEPTED'
        ) {
          player.survived =
            (player.survived ||
              0) + 1;

          player.streak =
            (player.streak ||
              0) + 1;

          player.active =
            true;
        } else {
          player.failed =
            (player.failed ||
              0) + 1;

          player.streak =
            0;

          player.active =
            false;
        }
      }

      lobby.verdicts =
        verdicts;

      lobby.state =
        'results';

      lobby.judgingProgress =
        null;

      lobby.gameOver =
        !lobby.players.some(
          player =>
            player.connected !==
              false &&
            player.active !==
              false
        );

      await saveLobby(
        lobby
      );

      return publicLobby(
        lobby,
        token
      );
    }
  );
}

export default async function handler(
  req,
  res
) {
  try {
    if (
      req.method ===
      'GET'
    ) {
      const code =
        String(
          req.query.code ||
            ''
        )
          .trim()
          .toUpperCase();

      const token =
        String(
          req.query.token ||
            ''
        );

      const lobby =
        await getLobby(
          code
        );

      if (!lobby) {
        return json(
          res,
          404,
          {
            ok: false,
            error:
              'Lobby not found.'
          }
        );
      }

      return json(
        res,
        200,
        {
          ok: true,
          lobby:
            publicLobby(
              lobby,
              token
            )
        }
      );
    }

    if (
      req.method !==
      'POST'
    ) {
      return json(
        res,
        405,
        {
          ok: false,
          error:
            'Method not allowed.'
        }
      );
    }

    const body =
      req.body || {};

    const action =
      body.action;

    let result;

    if (
      action ===
      'create'
    ) {
      result =
        await actionCreate(
          body.name
        );
    }

    else if (
      action ===
      'join'
    ) {
      result =
        await actionJoin(
          body.code,
          body.name
        );
    }

    else if (
      action ===
      'start'
    ) {
      result = {
        lobby:
          await actionStart(
            body.code,
            body.token
          )
      };
    }

    else if (
      action ===
      'submit'
    ) {
      result = {
        lobby:
          await actionSubmit(
            body.code,
            body.token,
            body.plan
          )
      };
    }

    else if (
      action ===
      'maybeJudge'
    ) {
      result = {
        lobby:
          await actionMaybeJudge(
            body.code,
            body.token
          )
      };
    }

    else {
      throw new Error(
        'Unknown action.'
      );
    }

    return json(
      res,
      200,
      {
        ok: true,
        ...result
      }
    );
  } catch (error) {
    console.error(error);

    return json(
      res,
      400,
      {
        ok: false,
        error:
          error.message ||
          'Request failed.'
      }
    );
  }
}
