// jev — physics backend interface + local mock.
// The game only talks to `client.step(request)`; swap the mock for the real
// jev backend by reimplementing connect() against the service transport.
const jev = (() => {
  const GRAVITY = 2200; // px/s^2

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // --- mock backend: same solver the real service would run server-side ---
  const stats = { steps: 0, hResolves: 0, vResolves: 0, landings: 0,
                  lastHit: 'none' };

  function solveStep(req) {
    const { body, solids, dt } = req;
    const out = { x: body.x, y: body.y, vx: body.vx, vy: body.vy,
                  onGround: false, touchingWall: 0 };
    stats.steps++;

    if (!body.noGravity) out.vy += GRAVITY * dt;

    // Horizontal axis: move, then push out of any solid.
    out.x += out.vx * dt;
    for (const s of solids) {
      const b = { x: out.x, y: out.y, w: body.w, h: body.h };
      if (!overlaps(b, s)) continue;
      stats.hResolves++;
      if (out.vx > 0)      { out.x = s.x - body.w; out.touchingWall = 1;  stats.lastHit = 'wall-right'; }
      else if (out.vx < 0) { out.x = s.x + s.w;    out.touchingWall = -1; stats.lastHit = 'wall-left'; }
      else {
        const dl = out.x + body.w - s.x, dr = s.x + s.w - out.x;
        out.x += dl < dr ? -dl : dr;
        stats.lastHit = 'wall-overlap';
      }
      out.vx = 0;
    }

    // Vertical axis: move, then push out; landing sets onGround.
    out.y += out.vy * dt;
    for (const s of solids) {
      const b = { x: out.x, y: out.y, w: body.w, h: body.h };
      if (!overlaps(b, s)) continue;
      stats.vResolves++;
      if (out.vy > 0)      { out.y = s.y - body.h; out.onGround = true; stats.lastHit = 'floor'; stats.landings++; }
      else if (out.vy < 0) { out.y = s.y + s.h; stats.lastHit = 'ceiling'; }
      else {
        const du = out.y + body.h - s.y, dd = s.y + s.h - out.y;
        out.y += du < dd ? -du : dd;
        stats.lastHit = 'floor-overlap';
      }
      out.vy = 0;
    }

    out.stats = stats;
    return out;
  }

  // --- mock enemy AI: the turret's brain, fed the player's movement history ---
  const FIRE_INTERVAL = 2.0;   // seconds between shots
  const BULLET_SPEED  = 260;   // px/s
  const turrets = {};          // per-shooter cadence: id -> lastFireAt/shots
  const adapt = {              // shared learned state: all shooters improve together
    aims: 0, missStreak: 0, dyBias: 0, leadMul: 1, hits: 0, misses: 0,
  };
  function turretState(id) {
    return turrets[id] || (turrets[id] = { lastFireAt: -Infinity, shots: 0 });
  }

  // Extract habits from the player's movement history.
  function analyze(h) {
    if (!h.length) return { avgVx: 0, jumpRate: 0, topX: null };
    const recent = h.slice(-90); // ~1.5 s
    const avgVx = recent.reduce((a, p) => a + (p.vx || 0), 0) / recent.length;
    // jump rate: count vy sign flips into negative (takeoffs) over window
    let jumps = 0;
    for (let i = 1; i < h.length; i++) {
      if ((h[i - 1].vy || 0) >= 0 && (h[i].vy || 0) < -100) jumps++;
    }
    const span = h.length ? (h[h.length - 1].t - h[0].t) || 1 : 1;
    // favourite territory: bucket x into 80-px zones, pick most occupied
    const zones = {};
    for (const p of h) zones[Math.floor(p.x / 80)] = (zones[Math.floor(p.x / 80)] || 0) + 1;
    const topZone = Object.entries(zones).sort((a, b) => b[1] - a[1])[0];
    return { avgVx, jumpRate: jumps / span, topX: topZone ? topZone[0] * 80 + 40 : null };
  }

  // req: { muzzle:{x,y}, history:[{t,x,y,vx,vy}], now, report?:{hit} }
  // res: { fire, dir:{x,y}, target:{x,y}, mode }
  function solveAim(req) {
    const t = turretState(req.id || 't0');
    adapt.aims++;

    // Outcome feedback: adapt after each resolved shot.
    if (req.report) {
      if (req.report.hit) {
        adapt.hits++; adapt.missStreak = 0;
        adapt.dyBias = 0; adapt.leadMul = 1;
      } else {
        adapt.misses++; adapt.missStreak++;
        adapt.dyBias = (adapt.missStreak % 2 ? -14 : 14);  // alternate high/low
        adapt.leadMul = 1 + Math.min(adapt.missStreak * 0.35, 1.4);
      }
    }

    const h = req.history;
    if (!h.length || req.now - t.lastFireAt < FIRE_INTERVAL) {
      return { fire: false };
    }
    t.lastFireAt = req.now;
    t.shots++;

    const habits = analyze(h);
    const player = h[h.length - 1];
    const dist = Math.hypot(player.x - req.muzzle.x, player.y - req.muzzle.y);
    const lead = (dist / BULLET_SPEED) * adapt.leadMul;

    let tx, ty, mode;
    if (habits.jumpRate > 0.6) {
      // habitual jumper: aim at the landing spot, not the airborne target
      tx = player.x + habits.avgVx * lead;
      ty = player.y + 60;
      mode = 'anti-jump';
    } else if (Math.abs(habits.avgVx) > 60) {
      // runner: lead the shot by learned velocity
      tx = player.x + habits.avgVx * lead;
      ty = player.y;
      mode = 'lead';
    } else {
      // camper: punish the favourite zone
      tx = habits.topX ?? player.x;
      ty = player.y - 10;
      mode = 'zone';
    }
    ty += adapt.dyBias;

    const dx = tx - req.muzzle.x, dy = ty - req.muzzle.y;
    const len = Math.hypot(dx, dy) || 1;
    return { fire: true, dir: { x: dx / len, y: dy / len },
             target: { x: tx, y: ty }, mode };
  }

  // --- mock monster brain: flies (no gravity), dashes every 1 s in 2D ---
  const DASH_INTERVAL = 1.0;  // seconds between dash decisions
  const DASH_SPEED    = 620;  // px/s impulse it requests
  const monsters = {};         // per-dasher cadence: id -> lastDashAt/dashes
  const brain = { decides: 0 };
  function monsterState(id) {
    return monsters[id] || (monsters[id] = { lastDashAt: -Infinity, dashes: 0 });
  }

  // req: { id, offset?, pos:{x,y}, history:[{t,x,y,vx,vy}], now }
  // res: { action:'dash'|'idle', dir:{x,y}, vx, vy }
  function solveDecide(req) {
    const m = monsterState(req.id || 'm0');
    brain.decides++;
    if (req.now - (req.offset || 0) - m.lastDashAt < DASH_INTERVAL) {
      return { action: 'idle' };
    }
    m.lastDashAt = req.now - (req.offset || 0);
    m.dashes++;
    // Habit read in 2D: intercept where the player's recent velocity says
    // they will be — horizontal lead plus a share of vertical motion, so it
    // swoops up at jumping players and dives at falling ones.
    const h = req.history;
    let avgVx = 0, avgVy = 0;
    if (h.length) {
      const recent = h.slice(-60);
      avgVx = recent.reduce((a, p) => a + (p.vx || 0), 0) / recent.length;
      avgVy = recent.reduce((a, p) => a + (p.vy || 0), 0) / recent.length;
    }
    const player = h.length ? h[h.length - 1] : { x: req.pos.x, y: req.pos.y };
    const aimX = player.x + avgVx * 0.4;
    const aimY = player.y + avgVy * 0.25;
    const dx = aimX - req.pos.x, dy = aimY - req.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len, ny = dy / len;
    m.lastAction = `dash ${nx > 0.3 ? '→' : nx < -0.3 ? '←' : ''}${ny < -0.3 ? '↑' : ny > 0.3 ? '↓' : ''}`;
    return { action: 'dash', dir: { x: nx, y: ny },
             vx: nx * DASH_SPEED, vy: ny * DASH_SPEED };
  }

  // Forget everything learned: physics counters, turret adaptation, monster.
  function resetMock() {
    Object.assign(stats, { steps: 0, hResolves: 0, vResolves: 0,
                           landings: 0, lastHit: 'none' });
    Object.assign(adapt, { aims: 0, missStreak: 0, dyBias: 0, leadMul: 1,
                           hits: 0, misses: 0 });
    for (const k in turrets) delete turrets[k];
    for (const k in monsters) delete monsters[k];
    brain.decides = 0;
  }

  // Mock client. When JEV_CONFIG.endpoint is set, step() POSTs the request
  // to the real jev backend; the request/response shape is unchanged.
  function connect() {
    const cfg = (typeof window !== 'undefined' && window.JEV_CONFIG) || {};
    const base = cfg.endpoint;
    const apiKey = cfg.apiKey;

    async function post(path, req) {
      const res = await fetch(base + '/' + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`jev backend ${res.status}`);
      return res.json();
    }

    return {
      // req: { body:{x,y,w,h,vx,vy,noGravity?}, solids:[{x,y,w,h}], dt }
      // res: { x, y, vx, vy, onGround, touchingWall, stats }
      async step(req) {
        if (!base) return solveStep(req); // local mock
        return post('step', req);
      },
      // req: { muzzle:{x,y}, history:[{t,x,y,vx}], now }
      // res: { fire, dir?, target?, predicted? }
      async aim(req) {
        if (!base) return solveAim(req);  // local mock
        return post('aim', req);
      },
      // req: { pos:{x,y}, history:[{t,x,y,vx,vy}], now }
      // res: { action:'dash'|'idle', dir?, vx? }
      async decide(req) {
        if (!base) return solveDecide(req); // local mock
        return post('decide', req);
      },
      // Forget server-side learned state (new game).
      async reset() {
        if (!base) { resetMock(); return; }
        return post('reset', {});
      },
    };
  }

  return { connect, GRAVITY };
})();

if (typeof globalThis !== 'undefined') globalThis.jev = jev;
