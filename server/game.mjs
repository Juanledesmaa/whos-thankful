// Game rules for Guess Who's Thankful.
// One JSON document per room. Every change goes through mutate(), which takes
// a short per-room lock so two phones submitting at once can't overwrite each other.

import { randomBytes, randomInt } from "node:crypto";

const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O: easy to misread on a projector
const MAX_PLAYERS = 60;
const MIN_PLAYERS = 2;
const NAME_MAX = 16;
const TEXT_MAX = 140;
const PROMPT_MAX = 100;
const POINTS_CORRECT = 100;
const LOCK_WAIT_MS = 8000;
const LOCK_STALE_MS = 5000;
export const DEFAULT_PROMPT = "What are you thankful for this year?";

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const wrongPhase = () => new GameError("The game has moved on.", 409);

const keyFor = (code) => `room-${code}`;
const token = (bytes = 12) => randomBytes(bytes).toString("base64url");
const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const normCode = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function load(store, code) {
  const room = await store.get(keyFor(code), { type: "json" });
  if (!room) throw new GameError("No game with that room code. Check the big screen.", 404);
  return room;
}

// The lock is a blob that only one request can create (onlyIfNew). A lock left
// behind by a crashed request is cleared once it is older than LOCK_STALE_MS.
async function withLock(store, code, work) {
  const lockKey = `lock-${code}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const { modified } = await store.set(lockKey, String(Date.now()), { onlyIfNew: true });
    if (modified) {
      try {
        return await work();
      } finally {
        await store.delete(lockKey).catch(() => {});
      }
    }
    const heldSince = Number(await store.get(lockKey));
    if (heldSince && Date.now() - heldSince > LOCK_STALE_MS) await store.delete(lockKey).catch(() => {});
    await sleep(20 + Math.random() * 60);
  }
  throw new GameError("The game is busy. Try that again.", 503);
}

async function mutate(store, code, change) {
  await load(store, code); // fail fast on a wrong code, before taking a lock
  return withLock(store, code, async () => {
    const room = await load(store, code);
    const extra = change(room) ?? {};
    room.v += 1;
    await store.setJSON(keyFor(code), room);
    return { room, extra };
  });
}

async function createRoom(store) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
    const room = {
      v: 1,
      code,
      hostKey: token(18),
      createdAt: Date.now(),
      phase: "lobby",
      prompt: DEFAULT_PROMPT,
      players: [],
      subs: {},
      order: [],
      round: 0,
      votes: {},
      history: [],
    };
    const { modified } = await store.setJSON(keyFor(code), room, { onlyIfNew: true });
    if (modified) return { code, hostKey: room.hostKey };
  }
  throw new GameError("Couldn't open a room. Try again.", 503);
}

function requireHost(room, body) {
  if (!body.hostKey || body.hostKey !== room.hostKey) {
    throw new GameError("Only the host screen can do that.", 403);
  }
}

function requirePlayer(room, body) {
  const player = body.pid && room.players.find((p) => p.id === body.pid);
  if (!player) throw new GameError("You're not in this game. Join again.", 403);
  return player;
}

function advance(room) {
  room.round += 1;
  room.votes = {};
  room.phase = room.round >= room.order.length ? "final" : "guess";
}

function clearRound(room) {
  room.subs = {};
  room.order = [];
  room.round = 0;
  room.votes = {};
  room.history = [];
  room.phase = "lobby";
}

const ACTIONS = {
  join(room, body) {
    const existing = body.pid && room.players.find((p) => p.id === body.pid);
    if (existing) return { pid: existing.id };
    if (body.pid && room.kicked?.includes(body.pid)) throw new GameError("The host removed you from this game.", 403);
    if (room.phase === "final") throw new GameError("This game is over. Ask the host to start a new one.");
    const name = clean(body.name, NAME_MAX);
    if (!name) throw new GameError("Type your first name to join.");
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError(`Someone is already ${name}. Add your last initial.`);
    }
    if (room.players.length >= MAX_PLAYERS) throw new GameError("This game is full.");
    const player = { id: token(), pub: token(6), name, score: 0 };
    room.players.push(player);
    return { pid: player.id };
  },

  submit(room, body) {
    const player = requirePlayer(room, body);
    if (room.phase !== "write") throw wrongPhase();
    const text = clean(body.text, TEXT_MAX);
    if (!text) throw new GameError("Write something first.");
    room.subs[player.pub] = text;
  },

  vote(room, body) {
    const player = requirePlayer(room, body);
    if (room.phase !== "guess") throw wrongPhase();
    const author = room.order[room.round];
    if (player.pub === author) throw new GameError("That one is yours. Sit this round out.");
    const target = String(body.target ?? "");
    if (!room.order.includes(target) || target === player.pub) throw new GameError("Pick one of the names.");
    room.votes[player.pub] = target;
  },

  start(room, body) {
    requireHost(room, body);
    if (room.phase !== "lobby") throw wrongPhase();
    if (room.players.length < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players.`);
    room.prompt = clean(body.prompt, PROMPT_MAX) || DEFAULT_PROMPT;
    room.phase = "write";
  },

  guessing(room, body) {
    requireHost(room, body);
    if (room.phase !== "write") throw wrongPhase();
    const authors = Object.keys(room.subs);
    if (authors.length < MIN_PLAYERS) throw new GameError(`Wait for at least ${MIN_PLAYERS} answers.`);
    room.order = shuffle(authors);
    room.round = 0;
    room.votes = {};
    room.history = [];
    room.phase = "guess";
  },

  reveal(room, body) {
    requireHost(room, body);
    if (room.phase !== "guess") throw wrongPhase();
    const author = room.order[room.round];
    const voters = Object.keys(room.votes);
    const right = voters.filter((pub) => room.votes[pub] === author);
    // The writer earns up to 100 for stumping the room, in steps of 10.
    const bonus = voters.length ? Math.round(((voters.length - right.length) / voters.length) * 10) * 10 : 0;
    for (const p of room.players) {
      if (right.includes(p.pub)) p.score += POINTS_CORRECT;
      if (p.pub === author) p.score += bonus;
    }
    room.history.push({ author, text: room.subs[author], votes: { ...room.votes }, bonus });
    room.phase = "reveal";
  },

  next(room, body) {
    requireHost(room, body);
    if (room.phase !== "reveal") throw wrongPhase();
    advance(room);
  },

  skip(room, body) {
    requireHost(room, body);
    if (room.phase !== "guess") throw wrongPhase();
    advance(room);
  },

  end(room, body) {
    requireHost(room, body);
    if (room.phase !== "guess" && room.phase !== "reveal") throw wrongPhase();
    room.votes = {};
    room.phase = "final";
  },

  kick(room, body) {
    requireHost(room, body);
    if (room.phase !== "lobby" && room.phase !== "write") throw wrongPhase();
    const pub = String(body.pub ?? "");
    const gone = room.players.find((p) => p.pub === pub);
    if (gone) (room.kicked ??= []).push(gone.id);
    room.players = room.players.filter((p) => p.pub !== pub);
    delete room.subs[pub];
  },

  // Same players, new question, scores carry over.
  again(room, body) {
    requireHost(room, body);
    if (room.phase !== "final") throw wrongPhase();
    clearRound(room);
  },

  // From any point: back to the lobby with answers and scores wiped. Players stay.
  reset(room, body) {
    requireHost(room, body);
    clearRound(room);
    for (const p of room.players) p.score = 0;
  },
};

// What one browser is allowed to see. Never includes who wrote the current
// answer, or any other player's private id.
function viewFor(room, body) {
  const isHost = Boolean(body.hostKey) && body.hostKey === room.hostKey;
  const me = body.pid ? room.players.find((p) => p.id === body.pid) : null;
  const nameOf = (pub) => room.players.find((p) => p.pub === pub)?.name ?? "Someone";
  const byName = (a, b) => a.name.localeCompare(b.name);

  const view = {
    v: room.v,
    code: room.code,
    phase: room.phase,
    prompt: room.prompt,
    isHost,
    minPlayers: MIN_PLAYERS,
    players: room.players.map((p) => ({
      pub: p.pub,
      name: p.name,
      score: p.score,
      submitted: p.pub in room.subs,
    })),
    me: me ? { pub: me.pub, name: me.name, score: me.score, text: room.subs[me.pub] ?? null } : null,
  };

  if (room.phase === "guess") {
    const author = room.order[room.round];
    view.round = {
      number: room.round + 1,
      total: room.order.length,
      text: room.subs[author],
      candidates: room.order.map((pub) => ({ pub, name: nameOf(pub) })).sort(byName),
      votesIn: Object.keys(room.votes).length,
      votersTotal: Math.max(room.players.length - 1, 0),
      myVote: me ? room.votes[me.pub] ?? null : null,
      mine: Boolean(me) && me.pub === author,
    };
  }

  if (room.phase === "reveal") {
    const last = room.history[room.history.length - 1];
    const counts = {};
    for (const target of Object.values(last.votes)) counts[target] = (counts[target] ?? 0) + 1;
    const voters = Object.keys(last.votes);
    let mine = null;
    if (me) {
      if (me.pub === last.author) mine = "author";
      else if (!(me.pub in last.votes)) mine = "none";
      else mine = last.votes[me.pub] === last.author ? "correct" : "wrong";
    }
    view.reveal = {
      number: room.round + 1,
      total: room.order.length,
      text: last.text,
      author: nameOf(last.author),
      bonus: last.bonus,
      points: POINTS_CORRECT,
      votersCount: voters.length,
      tally: room.order
        .filter((pub) => counts[pub] || pub === last.author)
        .map((pub) => ({ name: nameOf(pub), count: counts[pub] ?? 0, isAuthor: pub === last.author }))
        .sort((a, b) => b.count - a.count || byName(a, b)),
      rightNames: voters.filter((pub) => last.votes[pub] === last.author).map(nameOf).sort(),
      isLast: room.round + 1 >= room.order.length,
      mine,
    };
  }

  if (room.phase === "final") {
    const authors = room.order.length ? room.order : Object.keys(room.subs);
    view.final = {
      wall: authors.filter((pub) => room.subs[pub]).map((pub) => ({ name: nameOf(pub), text: room.subs[pub] })),
    };
  }

  return view;
}

async function route(store, body) {
  const action = String(body.action ?? "");
  if (action === "create") return createRoom(store);

  const code = normCode(body.code);
  if (code.length !== 4) throw new GameError("Enter the 4-letter room code.");

  if (action === "state") {
    return viewFor(await load(store, code), body);
  }

  const change = ACTIONS[action];
  if (!change) throw new GameError("Unknown action.");
  const { room, extra } = await mutate(store, code, (r) => change(r, body));
  return { ...viewFor(room, { ...body, ...extra }), ...extra };
}

// `store` needs get, set, setJSON and delete with the same shapes as @netlify/blobs,
// including the { onlyIfNew } option on writes.
export async function handleAction(store, body) {
  try {
    return { status: 200, data: await route(store, body ?? {}) };
  } catch (err) {
    if (err instanceof GameError) return { status: err.status, data: { error: err.message } };
    console.error(err);
    return { status: 500, data: { error: "Something broke on our side. Try again." } };
  }
}
