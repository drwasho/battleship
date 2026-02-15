# Moving Battleships (Three.js + Vite + TypeScript)

Web-based 3D Battleships-with-movement game with:
- 1 Player vs easy AI (deterministic RNG seed)
- 2 Player hotseat with pass-device overlay
- Placement, firing, simultaneous movement, ephemeral hit visibility, and ship HP pools
- Basic animations: muzzle flash, projectile arc, impact burst, sinking fade/tilt

## Stack
- Vite
- TypeScript
- Three.js
- Vitest (rules engine tests)

## Run
```bash
npm install
npm run dev
```

Open the local Vite URL (default `http://localhost:5173`).

## Build
```bash
npm run build
```

## Test
```bash
npm run test
```

## Controls
- `R` key or Rotate button: rotate placement / movement orientation.
- Placement phase: select ship in panel, hover left grid, click to place.
- Firing phase: select alive ship in panel, click target on right grid.
- Movement phase: select alive ship, click destination on left grid (or skip).

## Notes
- Misses remain visible on targeting map.
- Hits are ephemeral on targeting map and are cleared after movement resolution each round.
- Damage stacks by gun count at the selected cell for the firing ship.
