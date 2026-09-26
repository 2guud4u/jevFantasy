# jevFantasy

A 2D platformer where every physics tick and every enemy decision goes through **jev**, a physics/AI backend. Today that's a local mock solver in `jev.js`; set an endpoint and the identical calls go to the real service — the game never changes.

## The game

You have **30 seconds** to reach the flag as many times as possible. Each flag touch is +1 and you respawn — the clock doesn't stop. Deaths (spikes, bullets, monsters) respawn you. High score persists in `localStorage`.

A 3-second countdown starts each game. The debug HUD (top-left) shows live jev stats, the turret's current tactic, dasher states, and the last few requests sent to the engine.

## Controls

| Key | Action |
|-----|--------|
| ← → / A D | Move |
| Space / ↑ / W | Jump |
| R | Respawn (keeps jev's memory) |
| N | New game — resets clock, score, and jev's learned state |

## How jev gets its info

Every frame the game appends a sample to a rolling 12-second `history` buffer:

```js
{ t: 12.483, x: 340.2, y: 464, vx: 320, vy: 0 }
```

That buffer is the only player context enemies get — habits are computed from it server-side.

**Four API calls** (mocked locally in `jev.js`, POSTed to `{endpoint}/step|aim|decide|reset` when live):

| Call | Payload → Response | Purpose |
|------|-------------------|---------|
| `step` | `{body:{x,y,w,h,vx,vy,noGravity?}, solids[], dt}` → resolved body + `stats` | Physics for player, bullets, monsters. The game never moves anything itself. |
| `aim` | `{id, muzzle, history, now, report}` → `{fire, dir, target, mode}` | Turret brains. Per-`id` cooldown; `report` feeds back each bullet's hit/miss so aim adapts (`lead`/`zone`/`anti-jump` tactics). |
| `decide` | `{id, offset, pos, history, now}` → `{action, dir, vx, vy}` | Flying dashers — 1 s cadence, 2D intercept from your recent velocity. `offset` staggers the pair. |
| `reset` | `{}` | Forget all learned state on a new game. |

**Watching it learn:** the `turrets:` HUD line names the tactic jev picked (`zone` if you camp, `lead` if you run, `anti-jump` if you hop) and the aim target drifts after misses.

## Running it

Open `index.html`, or:

```
python3 -m http.server 8000
# → http://localhost:8000
```

## Going live against real jev

Create `jev.config.js` (git-ignored):

```js
window.JEV_CONFIG = {
  endpoint: 'https://your-jev-service',   // POSTs to .../step, /aim, /decide, /reset
  apiKey: 'apikey_...',                   // sent as Authorization: Bearer
};
```

Empty `endpoint` = local mock. The backend just needs the four routes above with the documented JSON shapes.

## Files

- `index.html` — canvas + below-game high score/controls
- `game.js` — level, input, render, run/score logic; zero physics
- `jev.js` — the backend seam + mock engine (solver, turret AI, dasher AI, reset)
- `jev.config.js` — local credentials (git-ignored)
