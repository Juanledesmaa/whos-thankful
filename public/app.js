(() => {
  "use strict";

  const app = document.getElementById("app");
  const query = new URLSearchParams(location.search);
  const POLL_MS = 1500;
  const PRESETS = [
    "What are you thankful for this year?",
    "Who are you thankful for, and why?",
    "What small thing are you thankful for that nobody would guess?",
    "What was hard this year that you're now thankful for?",
    "What food on the table are you most thankful for?",
  ];
  const LEAF_COLORS = ["#DD5A14", "#8C1C2C", "#5F7335", "#FFF1D0"];

  // ---------- helpers ----------

  const saved = {
    get(key) {
      try { return localStorage.getItem(key) || ""; } catch { return ""; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch {}
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch {}
    },
  };

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const normCode = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const ordinal = (n) => {
    const tail = ["th", "st", "nd", "rd"];
    const rem = n % 100;
    return n + (tail[(rem - 20) % 10] || tail[rem] || tail[0]);
  };
  const ranked = (players) => [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const leaf = (cls = "") => `<svg class="leaf ${cls}" aria-hidden="true"><use href="#leaf"/></svg>`;
  const sizeOf = (text) => (text.length > 90 ? "long" : text.length > 45 ? "medium" : "short");

  // ---------- state ----------

  const S = {
    mode: "home", // home | host | player
    code: "",
    hostKey: "",
    pid: "",
    view: null,
    error: "",
    offline: false,
    gone: "",
    busy: false,
    editing: false,
    epoch: 0,
    // What this phone last sent, so it can resend if the server ever loses it.
    sentText: null,
    sentVote: null,
    healing: false,
    promptDraft: "",
  };

  const hostCode = normCode(query.get("host"));
  const roomCode = normCode(query.get("room"));
  if (hostCode.length === 4) {
    S.code = hostCode;
    S.hostKey = saved.get(`gwt:host:${hostCode}`);
    if (S.hostKey) S.mode = "host";
    else S.error = "This browser isn't the host of that game. Start a new one, or join as a player.";
  } else if (roomCode.length === 4) {
    S.mode = "player";
    S.code = roomCode;
    S.pid = saved.get(`gwt:pid:${roomCode}`);
  }

  // ---------- server ----------

  async function api(action, data = {}) {
    let res;
    try {
      res = await fetch("/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...data }),
      });
    } catch {
      const err = new Error("Can't reach the game. Check your connection.");
      err.network = true;
      throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || "Something went wrong. Try again.");
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const creds = () => ({ code: S.code, pid: S.pid || undefined, hostKey: S.hostKey || undefined });

  async function act(action, data = {}) {
    if (S.busy) return false;
    S.busy = true;
    S.error = "";
    S.epoch++;
    try {
      S.view = await api(action, { ...creds(), ...data });
      S.offline = false;
      return true;
    } catch (err) {
      // 409 means the host already moved the game on; the next poll catches up.
      if (err.status !== 409) S.error = err.message;
      return false;
    } finally {
      S.busy = false;
      S.epoch++;
      render();
    }
  }

  async function join(code, name) {
    if (S.busy) return;
    S.busy = true;
    S.error = "";
    S.epoch++;
    try {
      const view = await api("join", { code, name });
      saved.set(`gwt:pid:${code}`, view.pid);
      saved.set(`gwt:name:${code}`, String(name).trim());
      if (S.mode === "home") {
        location.search = `?room=${code}`;
        return;
      }
      S.pid = view.pid;
      S.view = view;
    } catch (err) {
      S.error = err.message;
    } finally {
      S.busy = false;
      S.epoch++;
      render();
    }
  }

  // If the server doesn't have something this phone already sent (a write lost
  // in a burst of simultaneous taps), quietly send it again.
  async function heal(view) {
    if (S.healing) return;
    const resend = async (action, data) => {
      S.healing = true;
      try {
        S.view = await api(action, { ...creds(), ...data });
      } catch (err) {
        if (action === "join") {
          // The host removed this player, or the game ended: back to the join form.
          S.pid = "";
          saved.remove(`gwt:pid:${S.code}`);
          if (err.status === 403) S.error = err.message;
        }
      } finally {
        S.healing = false;
      }
    };

    if (view.phase !== "write") S.sentText = null;
    if (view.phase !== "guess") S.sentVote = null;

    if (!view.me) {
      const name = saved.get(`gwt:name:${S.code}`);
      if (!name || view.phase === "final") {
        S.pid = "";
        saved.remove(`gwt:pid:${S.code}`);
        return;
      }
      await resend("join", { name });
      if (S.view?.pid) {
        S.pid = S.view.pid;
        saved.set(`gwt:pid:${S.code}`, S.pid);
      }
      return;
    }
    if (view.phase === "write" && !view.me.text && S.sentText && !S.editing) {
      await resend("submit", { text: S.sentText });
    }
    if (view.phase === "guess" && !view.round.mine && !view.round.myVote && S.sentVote?.round === view.round.number) {
      await resend("vote", { target: S.sentVote.target });
    }
  }

  async function poll() {
    if (S.mode !== "home" && !S.gone && !S.busy && !document.hidden) {
      const epoch = S.epoch;
      try {
        const view = await api("state", creds());
        if (epoch === S.epoch) {
          S.view = view;
          if (S.mode === "player" && S.pid) await heal(view);
        }
        S.offline = false;
      } catch (err) {
        if (err.status === 404) S.gone = err.message;
        else S.offline = true;
      }
      render();
    }
    setTimeout(poll, POLL_MS);
  }

  // ---------- shared pieces ----------

  const brand = () => `<span class="brand">${leaf()}Guess Who's Thankful</span>`;

  function placecard({ label, text, foot, footClass = "" }) {
    return `
      <article class="placecard">
        <p class="placecard-label">${esc(label)}</p>
        <blockquote class="placecard-text ${sizeOf(text)}">${esc(text)}</blockquote>
        <p class="placecard-foot ${footClass}">${foot}</p>
      </article>`;
  }

  function scoreList(players, limit) {
    const rows = ranked(players).slice(0, limit ?? players.length);
    return `<ol class="scores">${rows
      .map((p) => `<li><span class="scores-name">${esc(p.name)}</span><span class="scores-pts">${p.score}</span></li>`)
      .join("")}</ol>`;
  }

  // ---------- home ----------

  function homeScreen() {
    return `
      <main class="screen phone home">
        <h1 class="title">Guess Who's Thankful</h1>
        <p class="lede">Everyone writes what they're thankful for. Then the room guesses who wrote what.</p>

        <form class="card" data-form="joinHome" autocomplete="off">
          <h2>Join a game</h2>
          <label for="code">Room code from the big screen</label>
          <input id="code" class="code-input" maxlength="4" autocapitalize="characters" spellcheck="false" placeholder="ABCD" required>
          <label for="name">Your first name</label>
          <input id="name" maxlength="16" required>
          <button class="btn primary">Join the game</button>
        </form>

        <section class="card quiet">
          <h2>Running the night?</h2>
          <p>Open this page on the screen everyone can see, then start a room.</p>
          <button class="btn" data-act="create">Host a new game</button>
        </section>
      </main>`;
  }

  function goneScreen() {
    return `
      <main class="screen phone">
        <header class="bar">${brand()}</header>
        <section class="card">
          <h1>That room isn't open</h1>
          <p>${esc(S.gone)}</p>
          <a class="btn primary" href="/">Back to the start</a>
        </section>
      </main>`;
  }

  // ---------- player ----------

  function playerBar(v) {
    return `<header class="bar">${brand()}${v.me ? `<span class="pill">${esc(v.me.name)} <b>${v.me.score}</b></span>` : ""}</header>`;
  }

  function joinScreen(v) {
    const over = v.phase === "final";
    return `
      <main class="screen phone">
        <header class="bar">${brand()}<span class="pill">Room <b>${esc(v.code)}</b></span></header>
        ${over
          ? `<section class="card"><h1>This game is over</h1><p>Ask the host to start another round, then join again.</p></section>`
          : `<form class="card" data-form="join" autocomplete="off">
              <h1>Join room ${esc(v.code)}</h1>
              <label for="name">Your first name</label>
              <input id="name" maxlength="16" required>
              <button class="btn primary">Join the game</button>
            </form>`}
      </main>`;
  }

  function playerScreen(v) {
    const me = v.me;
    if (v.phase !== "write") S.editing = false;
    let id = `player:${v.phase}`;
    let body = "";

    if (v.phase === "lobby") {
      body = `
        <section class="card">
          <h1>You're in, ${esc(me.name)}</h1>
          <p>Watch the big screen. The game starts once everyone has joined.</p>
          <p class="note">${count(v.players.length, "player", "players")} so far</p>
        </section>`;
    }

    if (v.phase === "write") {
      const writing = !me.text || S.editing;
      id += writing ? ":form" : ":sent";
      body = writing
        ? `<form class="card" data-form="submit">
            <h1 class="prompt">${esc(v.prompt)}</h1>
            <label for="answer" class="sr">Your answer</label>
            <textarea id="answer" maxlength="140" rows="4" placeholder="Be specific. It makes guessing more fun." required>${esc(me.text ?? "")}</textarea>
            <p class="note">Leave your name out. 140 characters at most.</p>
            <button class="btn primary">Send my answer</button>
          </form>`
        : `<section class="card">
            <h1>Answer sent</h1>
            <blockquote class="mine">${esc(me.text)}</blockquote>
            <p>Nobody sees who wrote it until the reveal.</p>
            <button class="btn" data-act="edit">Change my answer</button>
          </section>`;
    }

    if (v.phase === "guess") {
      const r = v.round;
      id += `:${r.number}`;
      if (r.mine) {
        body = `
          <section class="card center">
            <p class="note">Answer ${r.number} of ${r.total}</p>
            <h1>This one is yours</h1>
            <p>Keep a straight face while everyone guesses. You score more the more people you stump.</p>
          </section>`;
      } else {
        const picked = r.candidates.find((c) => c.pub === r.myVote);
        body = `
          <section class="card">
            <p class="note">Answer ${r.number} of ${r.total}</p>
            <blockquote class="mine">${esc(r.text)}</blockquote>
            <h1>Who wrote this?</h1>
            <div class="names">
              ${r.candidates
                .filter((c) => c.pub !== me.pub)
                .map((c) => `<button class="name" data-act="vote" data-pub="${esc(c.pub)}" aria-pressed="${c.pub === r.myVote}">${esc(c.name)}</button>`)
                .join("")}
            </div>
            <p class="note">${picked ? `You picked ${esc(picked.name)}. You can change it until the reveal.` : "Tap a name to lock in your guess."}</p>
          </section>`;
      }
    }

    if (v.phase === "reveal") {
      const r = v.reveal;
      id += `:${r.number}`;
      const result = {
        correct: `<p class="result good">You got it. +${r.points}</p>`,
        wrong: `<p class="result">Not this time.</p>`,
        none: `<p class="result">You didn't guess on this one.</p>`,
        author: `<p class="result good">That was you. +${r.bonus} for stumping the room.</p>`,
      }[r.mine] ?? "";
      body = `
        <section class="card center">
          <p class="note">Answer ${r.number} of ${r.total}</p>
          <h1>${esc(r.author)} wrote it</h1>
          <blockquote class="mine">${esc(r.text)}</blockquote>
          ${result}
          <p class="note">Your score: ${me.score}</p>
        </section>`;
    }

    if (v.phase === "final") {
      const order = ranked(v.players);
      const place = order.findIndex((p) => p.pub === me.pub) + 1;
      body = `
        <section class="card center">
          <h1>You finished ${ordinal(place)}</h1>
          <p>${me.score} points, out of ${count(order.length, "player", "players")}.</p>
          ${scoreList(v.players, 3)}
          <p class="note">Everyone's answers are up on the big screen.</p>
        </section>`;
    }

    return { id, html: `<main class="screen phone">${playerBar(v)}${body}</main>` };
  }

  // ---------- host ----------

  let qrCache = { url: "", svg: "" };
  function qrFor(url) {
    if (qrCache.url === url) return qrCache.svg;
    let svg = "";
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      qrCache = { url, svg };
    } catch {
      // QR library didn't load: the typed code still works.
    }
    return svg;
  }

  function hostBar(v) {
    const dirty = v.phase !== "lobby" || v.players.some((p) => p.score > 0);
    return `<header class="bar">${brand()}<span class="bar-right">
      ${dirty ? `<button class="btn small" data-act="reset">Reset game</button>` : ""}
      <span class="pill">Join at ${esc(location.host)} with <b>${esc(v.code)}</b></span>
    </span></header>`;
  }

  function playerChips(v, { showDone = false } = {}) {
    if (!v.players.length) return `<p class="empty">Nobody yet. Scan the code to be first.</p>`;
    return `<ul class="chips">${v.players
      .map(
        (p) => `<li class="chip ${showDone && p.submitted ? "done" : ""}">
          ${esc(p.name)}
          <button class="chip-x" data-act="kick" data-pub="${esc(p.pub)}" data-name="${esc(p.name)}" aria-label="Remove ${esc(p.name)}">&times;</button>
        </li>`
      )
      .join("")}</ul>`;
  }

  let leavesCache = "";
  function leafBurst() {
    if (!leavesCache) {
      leavesCache = `<div class="burst" aria-hidden="true">${Array.from({ length: 30 }, (_, i) => {
        const x = Math.round(Math.random() * 100);
        const delay = (Math.random() * 1.6).toFixed(2);
        const fall = (3.2 + Math.random() * 2.4).toFixed(2);
        const spin = Math.round(180 + Math.random() * 540) * (i % 2 ? 1 : -1);
        const size = (1.4 + Math.random() * 1.8).toFixed(2);
        return `<svg class="leaf" style="left:${x}%;width:${size}rem;height:${size}rem;color:${LEAF_COLORS[i % LEAF_COLORS.length]};--delay:${delay}s;--fall:${fall}s;--spin:${spin}deg"><use href="#leaf"/></svg>`;
      }).join("")}</div>`;
    }
    return leavesCache;
  }

  function hostScreen(v) {
    let id = `host:${v.phase}`;
    let body = "";
    const joinUrl = `${location.origin}/?room=${v.code}`;

    if (v.phase === "lobby") {
      const ready = v.players.length >= v.minPlayers;
      body = `
        <div class="split lobby">
          <section class="card joinbox">
            <div class="qr">${qrFor(joinUrl)}</div>
            <p>Scan to join, or go to <b>${esc(location.host)}</b> and type</p>
            <p class="roomcode">${esc(v.code)}</p>
          </section>
          <section class="stack">
            <h1>${v.players.length ? `${count(v.players.length, "player", "players")} at the table` : "Pull up a chair"}</h1>
            ${playerChips(v)}
            <div class="card question">
              <label for="prompt">Tonight's question</label>
              <input id="prompt" maxlength="100" value="${esc(S.promptDraft)}" placeholder="${esc(PRESETS[0])}">
              <p class="note">Leave it blank to ask the question above, type your own, or tap one of these.</p>
              <div class="presets">
                ${PRESETS.map((p) => `<button type="button" class="preset" data-act="preset">${esc(p)}</button>`).join("")}
              </div>
            </div>
            <div class="actions">
              <button class="btn primary big" data-act="start" ${ready ? "" : "disabled"}>Start writing</button>
              ${ready ? "" : `<span class="note">Needs at least ${v.minPlayers} players.</span>`}
            </div>
          </section>
        </div>`;
    }

    if (v.phase === "write") {
      const done = v.players.filter((p) => p.submitted).length;
      const ready = done >= v.minPlayers;
      body = `
        <section class="stack center">
          <p class="kicker">Answer on your phone</p>
          <h1 class="bigprompt">${esc(v.prompt)}</h1>
          <p class="tallyline">${done} of ${v.players.length} answers in</p>
          ${playerChips(v, { showDone: true })}
          <div class="actions">
            <button class="btn primary big" data-act="guessing" ${ready ? "" : "disabled"}>Start guessing</button>
            ${ready ? "" : `<span class="note">Needs at least ${v.minPlayers} answers.</span>`}
          </div>
        </section>`;
    }

    if (v.phase === "guess") {
      const r = v.round;
      id += `:${r.number}`;
      body = `
        <section class="stack center">
          ${placecard({ label: `Answer ${r.number} of ${r.total}`, text: r.text, foot: "Who wrote this?" })}
          <p class="tallyline">${r.votesIn} of ${r.votersTotal} guesses in</p>
          <div class="actions">
            <button class="btn primary big" data-act="reveal">Reveal who wrote it</button>
            <button class="btn" data-act="skip">Skip this answer</button>
            <button class="btn" data-act="end">End the game</button>
          </div>
        </section>`;
    }

    if (v.phase === "reveal") {
      const r = v.reveal;
      id += `:${r.number}`;
      const most = Math.max(1, ...r.tally.map((t) => t.count));
      body = `
        <div class="split reveal">
          <section class="stack">
            ${placecard({ label: `Answer ${r.number} of ${r.total}`, text: r.text, foot: `${esc(r.author)} wrote this`, footClass: "revealed" })}
            <p class="tallyline">
              ${r.rightNames.length
                ? `${esc(r.rightNames.join(", "))} guessed right.`
                : r.votersCount ? "Nobody guessed it." : "No guesses came in."}
              ${r.bonus ? `${esc(r.author)} earns ${r.bonus} for stumping the room.` : ""}
            </p>
          </section>
          <section class="stack">
            <div class="card">
              <h2>The guesses</h2>
              <ul class="bars">
                ${r.tally
                  .map(
                    (t) => `<li class="${t.isAuthor ? "is-author" : ""}">
                      <span class="bars-name">${esc(t.name)}</span>
                      <span class="bars-track"><span class="bars-fill" style="width:${Math.round((t.count / most) * 100)}%"></span></span>
                      <span class="bars-count">${t.count}</span>
                    </li>`
                  )
                  .join("")}
              </ul>
            </div>
            <div class="card">
              <h2>Top of the table</h2>
              ${scoreList(v.players, 5)}
            </div>
            <div class="actions">
              <button class="btn primary big" data-act="next">${r.isLast ? "Show final scores" : "Next answer"}</button>
              ${r.isLast ? "" : `<button class="btn" data-act="end">End the game</button>`}
            </div>
          </section>
        </div>`;
    }

    if (v.phase === "final") {
      const order = ranked(v.players);
      const [first, second, third] = order;
      const step = (p, place) =>
        p ? `<li class="step p${place}"><span class="step-name">${esc(p.name)}</span><span class="step-pts">${p.score}</span><span class="step-block">${ordinal(place)}</span></li>` : "";
      body = `
        ${leafBurst()}
        <section class="stack center">
          <h1 class="title">Happy Thanksgiving</h1>
          <ol class="podium">${step(second, 2)}${step(first, 1)}${step(third, 3)}</ol>
        </section>
        <div class="split final">
          <section class="card">
            <h2>Everyone's scores</h2>
            ${scoreList(v.players)}
          </section>
          <section class="stack">
            <h2 class="on-bg">What this room is thankful for</h2>
            <ul class="wall">
              ${v.final.wall.map((w) => `<li><blockquote>${esc(w.text)}</blockquote><b>${esc(w.name)}</b></li>`).join("")}
            </ul>
            <div class="actions">
              <button class="btn primary" data-act="again">Play again and keep scores</button>
            </div>
          </section>
        </div>`;
    }

    return { id, html: `<main class="screen stage">${hostBar(v)}${body}</main>` };
  }

  // ---------- render ----------

  function currentScreen() {
    if (S.gone) return { id: "gone", html: goneScreen() };
    if (S.mode === "home") return { id: "home", html: homeScreen() };
    if (!S.view) return { id: "loading", html: `<main class="screen phone"><p class="loading">Setting the table…</p></main>` };
    if (S.mode === "host") return hostScreen(S.view);
    if (!S.view.me) return { id: "join", html: joinScreen(S.view) };
    return playerScreen(S.view);
  }

  function notices() {
    return `
      ${S.error ? `<p class="toast error" role="alert">${esc(S.error)}</p>` : ""}
      ${S.offline ? `<p class="toast" role="status">Reconnecting…</p>` : ""}`;
  }

  let lastHtml = "";
  let lastId = "";
  function render() {
    const { id, html } = currentScreen();
    const full = html + notices();
    if (full === lastHtml) return;

    // Keep what someone is typing when the screen refreshes underneath them.
    const sameScreen = id === lastId;
    const fields = {};
    let focus = null;
    if (sameScreen) {
      for (const el of app.querySelectorAll("input[id], textarea[id]")) fields[el.id] = el.value;
      const active = document.activeElement;
      if (active && active.id && app.contains(active)) {
        focus = { id: active.id, start: active.selectionStart, end: active.selectionEnd };
      }
    }

    app.innerHTML = full;
    lastHtml = full;
    document.documentElement.classList.toggle("host", S.mode === "host");

    if (sameScreen) {
      for (const [fieldId, value] of Object.entries(fields)) {
        const el = document.getElementById(fieldId);
        if (el) el.value = value;
      }
      if (focus) {
        const el = document.getElementById(focus.id);
        if (el) {
          el.focus();
          try { el.setSelectionRange(focus.start, focus.end); } catch {}
        }
      }
    } else {
      lastId = id;
      app.firstElementChild?.classList.add("fresh");
      window.scrollTo(0, 0);
    }
  }

  // ---------- events ----------

  const clicks = {
    async create() {
      if (S.busy) return;
      S.busy = true;
      try {
        const { code, hostKey } = await api("create");
        saved.set(`gwt:host:${code}`, hostKey);
        location.search = `?host=${code}`;
      } catch (err) {
        S.error = err.message;
        S.busy = false;
        render();
      }
    },
    preset(el) {
      const input = document.getElementById("prompt");
      input.value = el.textContent;
      S.promptDraft = input.value;
    },
    start() {
      S.promptDraft = document.getElementById("prompt")?.value ?? S.promptDraft;
      act("start", { prompt: S.promptDraft });
    },
    guessing: () => act("guessing"),
    reveal: () => act("reveal"),
    next: () => act("next"),
    skip: () => act("skip"),
    again: () => act("again"),
    async reset() {
      if (!confirm("Reset the game? Answers and scores are cleared. Players stay in the room.")) return;
      if (await act("reset")) {
        S.promptDraft = "";
        render();
      }
    },
    end() {
      if (confirm("End the game now and show final scores?")) act("end");
    },
    kick(el) {
      if (confirm(`Remove ${el.dataset.name} from the game?`)) act("kick", { pub: el.dataset.pub });
    },
    async vote(el) {
      const round = S.view?.round?.number;
      if (await act("vote", { target: el.dataset.pub })) S.sentVote = { round, target: el.dataset.pub };
    },
    edit() {
      S.editing = true;
      render();
    },
  };

  const forms = {
    joinHome(form) {
      const code = normCode(form.querySelector("#code").value);
      if (code.length !== 4) {
        S.error = "Enter the 4-letter room code.";
        render();
        return;
      }
      join(code, form.querySelector("#name").value);
    },
    join: (form) => join(S.code, form.querySelector("#name").value),
    async submit(form) {
      const text = form.querySelector("#answer").value;
      if (await act("submit", { text })) {
        S.sentText = text;
        S.editing = false;
        render();
      }
    },
  };

  app.addEventListener("click", (event) => {
    const el = event.target.closest("[data-act]");
    if (el && !el.disabled) clicks[el.dataset.act]?.(el);
  });
  app.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target.closest("[data-form]");
    if (form) forms[form.dataset.form]?.(form);
  });
  app.addEventListener("input", (event) => {
    if (event.target.id === "prompt") S.promptDraft = event.target.value;
    if (event.target.id === "code") event.target.value = normCode(event.target.value);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) S.epoch++; // drop any stale in-flight poll; the loop picks up fresh
  });

  render();
  poll();
})();
