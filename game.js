// jevFantasy — simple 2D platformer. All physics goes through the jev backend.
(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const MOVE = 320;   // px/s horizontal speed
  const JUMP = 780;   // px/s jump impulse

  // Level: solids (static rects), spikes (hazards), goal flag, spawn point.
  const level = {
    spawn: { x: 40, y: 380 },
    solids: [
      { x: 0,    y: 500, w: 400, h: 40 },   // ground A
      { x: 480,  y: 500, w: 480, h: 40 },   // ground B (gap between)
      { x: 200,  y: 400, w: 120, h: 20 },
      { x: 60,   y: 300, w: 110, h: 20 },   // left ledge over spawn
      { x: 340,  y: 240, w: 100, h: 20 },   // high left-center
      { x: 400,  y: 320, w: 120, h: 20 },
      { x: 430,  y: 430, w: 50,  h: 15 },   // stepping stone in the gap
      { x: 620,  y: 400, w: 120, h: 20 },
      { x: 560,  y: 280, w: 100, h: 20 },   // mid-high right
      { x: 700,  y: 180, w: 100, h: 20 },   // high right
      { x: 780,  y: 300, w: 120, h: 20 },
      { x: 0,    y: 0,   w: 20,  h: 540 },  // left wall
      { x: 940,  y: 0,   w: 20,  h: 540 },  // right wall
    ],
    spikes: [
      { x: 520, y: 486, w: 60, h: 14 },
      { x: 680, y: 486, w: 60, h: 14 },
    ],
    goal: { x: 800, y: 236, w: 30, h: 64 },
  };

  const player = { x: level.spawn.x, y: level.spawn.y, w: 28, h: 36,
                   vx: 0, vy: 0, onGround: false };

  const keys = {};
  addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'KeyR') respawn();
    if (e.code === 'KeyN') newGame();
  });
  addEventListener('keyup', e => { keys[e.code] = false; });

  const MONSTERS = [   // flying dashers — jev decides(), jev steps
    { id: 'm0', spawn: { x: 500, y: 300 }, offset: 0 },
    { id: 'm1', spawn: { x: 700, y: 200 }, offset: 0.5 },
  ].map(m => ({ ...m, x: m.spawn.x, y: m.spawn.y, w: 34, h: 36,
                vx: 0, vy: 0, noGravity: true, log: 'idle' }));

  function respawn() {
    player.x = level.spawn.x; player.y = level.spawn.y;
    player.vx = 0; player.vy = 0;
    // new round: monsters and live bullets reset too
    for (const m of MONSTERS) {
      m.x = m.spawn.x; m.y = m.spawn.y; m.vx = 0; m.vy = 0; m.log = 'idle';
    }
    bullets.length = 0;
  }

  // New game: respawn plus forget everything — local history and jev's
  // learned state both go back to zero.
  async function newGame() {
    history.length = 0;
    reqLog.length = 0;
    aimLog = 'awaiting jev';
    pendingReport = null;
    stats = null;
    runElapsed = -COUNTDOWN_SECONDS;  // countdown runs before the clock starts
    gameOver = false;
    score = 0;
    respawn();
    await backend.reset();
  }

  // Run mode: 30 s per game after a 3 s countdown; score = flags reached.
  const RUN_SECONDS = 30;
  const COUNTDOWN_SECONDS = 3;
  let runElapsed = -COUNTDOWN_SECONDS;   // first game counts down on load too
  let gameOver = false;
  let score = 0;
  let highScore = +(localStorage.getItem('jevf.highScore') || 0);

  let stats = null;        // last telemetry returned by jev
  const reqLog = [];       // last N requests sent to jev

  // Stationary enemies — two jev-controlled turrets.
  const TURRETS = [
    { id: 't0', x: 660, y: 372, w: 26, h: 28 },
    { id: 't1', x: 206, y: 372, w: 26, h: 28 },
  ].map(t => ({ ...t, muzzle: { x: t.x + t.w / 2, y: t.y + t.h / 2 } }));
  const BULLET_SPEED = 260;
  const bullets = [];          // bodies stepped by jev each frame
  const history = [];          // player movement history sent to jev aim()
  const HISTORY_SECS = 12;
  let aimLog = 'awaiting jev'; // last aim() verdict for HUD
  let pendingReport = null;    // outcome of last shot, fed back to jev

  const backend = jev.connect();
  const touching = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  async function update(dt) {
    if (gameOver) return;
    runElapsed += dt;
    if (runElapsed < 0) return;              // countdown: world frozen, timer shows 3-2-1
    if (runElapsed >= RUN_SECONDS) { endRun(); return; }

    const left = keys.ArrowLeft || keys.KeyA;
    const right = keys.ArrowRight || keys.KeyD;
    player.vx = (right ? MOVE : 0) - (left ? MOVE : 0);

    if ((keys.Space || keys.ArrowUp || keys.KeyW) && player.onGround) {
      player.vy = -JUMP;
      player.onGround = false;
    }

    // Record play history — this is the context jev aims with.
    const now = performance.now() / 1000;
    history.push({ t: now, x: player.x, y: player.y, vx: player.vx, vy: player.vy });
    while (history.length && now - history[0].t > HISTORY_SECS) history.shift();

    const req = {
      body: { x: player.x, y: player.y, w: player.w, h: player.h,
              vx: player.vx, vy: player.vy },
      solids: level.solids,
      dt,
    };
    reqLog.push(req);
    if (reqLog.length > 6) reqLog.shift();
    const res = await backend.step(req);
    Object.assign(player, res);
    stats = res.stats || stats;

    // jev aims each turret independently (per-id cooldown, shared learning).
    // pendingReport feeds the last bullet's outcome back so jev adapts.
    let report = pendingReport;
    pendingReport = null;
    for (const t of TURRETS) {
      const aim = await backend.aim({
        id: t.id, muzzle: t.muzzle, history, now, report,
      });
      report = null; // outcome counts once
      if (aim.fire) {
        bullets.push({
          x: t.muzzle.x - 4, y: t.muzzle.y - 4, w: 8, h: 8,
          vx: aim.dir.x * BULLET_SPEED, vy: aim.dir.y * BULLET_SPEED,
          noGravity: true,
        });
        aimLog = `${t.id} ${aim.mode} → ${Math.round(aim.target.x)},${Math.round(aim.target.y)}`;
      } else if (aimLog === 'awaiting jev') aimLog = 'hold';
    }

    // jev steps every live bullet; cull on wall/solid contact or player hit.
    for (const b of bullets) {
      const br = await backend.step({ body: b, solids: level.solids, dt });
      Object.assign(b, br);
      b.dead = b.touchingWall !== 0 || b.onGround ||
               (br.vx === 0 && br.vy === 0) ||
               b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20;
    }
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (touching(bullets[i], player)) { pendingReport = { hit: true }; respawn(); return; }
      if (bullets[i].dead) { bullets.splice(i, 1); pendingReport = { hit: false }; }
    }

    // jev is each monster's brain: decide() per frame, dash gated at 1 s
    // (m1 has a 0.5 s phase offset so they don't dash in lockstep).
    for (const m of MONSTERS) {
      const dec = await backend.decide({
        id: m.id, offset: m.offset,
        pos: { x: m.x, y: m.y }, history, now,
      });
      if (dec.action === 'dash') {
        m.vx = dec.vx;
        m.vy = dec.vy;                       // flying: dash has a 2D vector
        m.log = `dash ${dec.dir.x > 0.3 ? '→' : dec.dir.x < -0.3 ? '←' : ''}` +
                `${dec.dir.y < -0.3 ? '↑' : dec.dir.y > 0.3 ? '↓' : ''}`;
      } else {
        m.vx *= 0.94;                        // glide dampening between dashes
        m.vy *= 0.94;
        if (Math.hypot(m.vx, m.vy) < 20) m.log = 'idle';
      }
      const mr = await backend.step({ body: m, solids: level.solids, dt });
      Object.assign(m, mr);
      if (m.touchingWall !== 0) m.vx = 0;
      if (touching(m, player)) { respawn(); return; }
    }

    for (const s of level.spikes) if (touching(player, s)) { respawn(); return; }
    if (touching(player, level.goal)) { score++; respawn(); return; }
    if (player.y > H + 100) respawn();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#3a3a5e';
    for (const s of level.solids) ctx.fillRect(s.x, s.y, s.w, s.h);

    ctx.fillStyle = '#e23a3a';
    for (const s of level.spikes) {
      const n = Math.floor(s.w / 12);
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(s.x + i * 12, s.y + s.h);
        ctx.lineTo(s.x + i * 12 + 6, s.y);
        ctx.lineTo(s.x + i * 12 + 12, s.y + s.h);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#4ae28a';
    ctx.fillRect(level.goal.x + 12, level.goal.y, 4, level.goal.h);
    ctx.beginPath();
    ctx.moveTo(level.goal.x + 16, level.goal.y);
    ctx.lineTo(level.goal.x + 40, level.goal.y + 10);
    ctx.lineTo(level.goal.x + 16, level.goal.y + 20);
    ctx.fill();

    // Turrets (jev-controlled) and their bullets.
    for (const t of TURRETS) {
      ctx.fillStyle = '#c94ac9';
      ctx.fillRect(t.x, t.y, t.w, t.h);
      ctx.fillStyle = '#ff7bd5';
      ctx.fillRect(t.muzzle.x - 3, t.muzzle.y - 3, 6, 6);
    }
    ctx.fillStyle = '#ffb84a';
    for (const b of bullets) ctx.fillRect(b.x, b.y, b.w, b.h);

    // Flying dashers (jev-brained).
    for (const m of MONSTERS) {
      ctx.fillStyle = '#8a2f2f';
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.fillStyle = '#ffdddd';
      ctx.fillRect(m.x + (m.vx >= 0 ? 20 : 4), m.y + 8, 8, 8); // eye leads the dash
    }

    ctx.fillStyle = '#5aa9ff';
    ctx.fillRect(player.x, player.y, player.w, player.h);

    if (gameOver) {
      ctx.fillStyle = '#fff';
      ctx.font = '28px monospace';
      ctx.fillText(`GAME OVER — score ${score}`, 300, 255);
      ctx.font = '18px monospace';
      ctx.fillText(`best ${highScore} — N for new game`, 330, 285);
    }

    if (runElapsed < 0 && !gameOver) {
      ctx.fillStyle = '#fff';
      ctx.font = '64px monospace';
      ctx.fillText(Math.ceil(-runElapsed), W / 2 - 18, H / 2);
      ctx.font = '16px monospace';
      ctx.fillText('GET READY', W / 2 - 44, H / 2 + 30);
    }
  }

  function endRun() {
    gameOver = true;
    if (score > highScore) {
      highScore = score;
      localStorage.setItem('jevf.highScore', String(highScore));
    }
  }

  // HUD: live stats + request log reported by/to jev.

  const bestEl = document.getElementById('best');
  function drawStats() {
    if (!stats) return;
    const fmt = n => Math.round(n);
    const lines = [
      `jev engine`,
      `⏱ ${Math.max(0, RUN_SECONDS - runElapsed).toFixed(0)}s  score ${score}`,
      `vx ${player.vx.toFixed(0)}  vy ${player.vy.toFixed(0)}`,
      `ground ${player.onGround}  wall ${player.touchingWall}`,
      `steps ${stats.steps}  hits h:${stats.hResolves} v:${stats.vResolves}`,
      `landings ${stats.landings}  last ${stats.lastHit}`,
      `turrets: ${aimLog}  bullets ${bullets.length}  hist ${history.length}`,
      `dashers: ${MONSTERS.map(m => `${m.id}:${m.log}`).join('  ')}`,
      `— requests →`,
      ...reqLog.map(r =>
        `x${fmt(r.body.x)} y${fmt(r.body.y)} vx${fmt(r.body.vx)} vy${fmt(r.body.vy)} dt${r.dt.toFixed(3)}`),
    ];
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(26, 24, 320, 14 * lines.length + 12);
    ctx.fillStyle = '#9fd0ff';

    bestEl.textContent = `BEST ${highScore}`;
    lines.forEach((l, i) => ctx.fillText(l, 34, 40 + i * 14));
  }

  let last = performance.now();
  async function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30); // clamp big tab-switch jumps
    last = now;
    await update(dt);
    draw();
    drawStats();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Debug/test handle.
  window.__game = { player, level, respawn, newGame, bullets, history,
                    monsters: MONSTERS, turrets: TURRETS,
                    get score() { return score; }, get runElapsed() { return runElapsed; },
                    set runElapsed(v) { runElapsed = v; },
                    get gameOver() { return gameOver; }, get highScore() { return highScore; } };
})();
