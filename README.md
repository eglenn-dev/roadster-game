# Roadster

A browser driving simulator of the next-generation Tesla Roadster, recreating the
demos from its unveiling on **October 15, 2026** at SpaceX's rocket development
facility in McGregor, Texas.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # spec + demo + handling checks (headless physics)
npm run build    # production bundle in dist/ (~340 KB gzipped, no other assets)
```

Renders with three.js `WebGPURenderer` (WebGPU, automatic WebGL 2 fallback; add
`?webgl` to the URL to force the fallback). Everything — car models, venue,
textures, audio — is procedural, so there is nothing to download besides the JS.

## The demos

| Mode | What happened on stage | In game |
| --- | --- | --- |
| **The Inverted Arch** | Car drove up a curved ramp until upside down, held on its suction fans (up to 2 G), dropped, flipped mid-air and landed with thrusters slowing the descent | Climb the 19 m arch, stop upside down for 2 s, SPACE to drop; the flight computer rolls you upright and fires a landing burn |
| **Lineup Kickflip** | Lifted on thrusters over a Cybercab, Cybertruck, Semi, Model Y and Model 3 with a "kick flip" | 40 mph, SPACE at the red/white bar, hold Q/E to kickflip, land past the line |
| **0–60 Launch** | On-screen 0–60 mph run of 0.81 s | Drag-strip tree, launch control (hold W+S), 1-ft rollout timing, ¼ mile |
| **Top Speed Run** | "Over 230 mph" | Two-mile strip with speed trap |
| **Free Drive** | — | Whole site at night, N₂ refill pads |

Every demo can be driven yourself or watched with **Optimus at the wheel**
(press any drive key to take over). Press **V** for a replay with broadcast cameras.

## Specs the simulation meets

All three trims (Performance, Thrust, Rocket) are simulated with the same
240 Hz rigid-body model: slip-based tire forces, two independently driven rear
motors with torque vectoring and traction control, multi-mode suction fans that
seal on floor gap, active aero with a self-adjusting wing, and cold-gas thrusters
fed from a finite N₂ impulse budget.

| Claim (Tesla) | Performance | Thrust | Rocket |
| --- | --- | --- | --- |
| 0–60 mph (1-ft rollout) | < 1.6 s → **1.47 s** | < 0.9 s → **0.80 s** (stage run 0.81 s) | < 0.59 s → **0.56 s** |
| Top speed > 230 mph | **234.8 mph** | **234.8 mph** | **234.8 mph** |
| Range > 300 mi (65 mph) | **346 mi** | **340 mi** | **335 mi** |
| Holds upside down at rest | ✓ | ✓ | ✓ |

These numbers come from `src/sim/benchmarks.ts` and are asserted in
`tests/specs.test.ts`; the in-game **Spec verification** screen runs the same code.

Published specs used: 1,000+ kW from two rear motors, < 1,700 kg target, 111.2 in
wheelbase, ~2 m width, 2 G suction fans, 200 L N₂ at ~690 bar for Thrust (~5 s
of thrust), 600 L and ten perimeter thrusters for Rocket. Battery size, tire grip
and thruster force are not public; they're estimates tuned so the car meets the
published claims.

## Controls

| | Keyboard | Gamepad |
| --- | --- | --- |
| Throttle / brake (reverse when stopped) | W / S | RT / LT |
| Steer | A / D | Left stick |
| Launch control | hold W + S, release S | RT + LT |
| Lift thrusters · drop from the arch | Space | A |
| Rear thrusters | Shift | X |
| Air pitch / yaw · roll (kickflip) | W S A D · Q E | Right stick · LB RB |
| Suction fan mode · Track Mode · flight assist | F · T · G | D-pad |
| Camera · restart · replay · Optimus | C · R · V · O | Y · Back |
| Pause · mute · hide HUD | Esc · M · U | Start |

## Performance

- WebGPU render pipeline (TSL post: bloom, SMAA/FXAA, vignette) with four quality presets
- Dynamic resolution holds the frame rate by scaling render resolution (ignores throttled tabs)
- Static props are merged per material at load (≈230 draw calls for the whole site)
- Particles are a single instanced draw per pool with GPU billboarding
- Physics is allocation-free in the hot loop; ~0.1 ms per frame

## Layout

```
src/sim/      physics: vehicle dynamics, world surfaces, autopilots, benchmarks, specs
src/models/   procedural car modelling (lofted bodies, wheels), Roadster + lineup cars
src/render/   engine/post-processing, sky & lighting, ground shader, venue
src/fx/       thruster plumes, particles, skid marks
src/game/     game loop, modes, camera, input, audio, replay, UI
tests/        headless spec, demo and handling tests
```
