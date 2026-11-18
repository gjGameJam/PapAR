# Trailbound

**Trailbound** is a spatial territory game for **Snap Spectacles**, built in **Lens Studio 5.25** with **TypeScript**, **Interaction Kit 4.0**, **UIKit 4.0**, **Motion 4.0**, and **SyncKit 4.0.0**. Play solo against bots or join other players through Connected Lenses.

Leave your cyan home, walk a loop, and return to fill it. Three local bot rivals play by the same rules: cut their trails, avoid crossing your own, and finish the 90-second round with the highest score.

## Play

1. Open `Trailbound.esproj` in Lens Studio **5.25.0.26111006** or a compatible newer 5.25 build.
2. Deploy to Spectacles.
3. Read the world-space safety panel and pinch **START**.
4. Use a **clear 3 × 3 m area**. Walk—**never run** and watch for obstacles.

Preview includes an automatic cyan pilot. On physical Spectacles, device movement always controls the cyan player. UI uses a world-space panel and UIKit controls; there is no orthographic camera or screen-space HUD.

## Rules

- Leave cyan territory to lay a trail; return to convert it and flood-fill enclosed cells.
- Each claimed cell scores **10 points**; each rival trail cut scores **50 points**.
- Crossing your own exposed trail or leaving the arena eliminates you.
- Respawn takes **3 seconds** on open ground.
- The highest score after **90 seconds** wins. Pinch **REPLAY** for another round.
- Follow the pulsing first-loop guide.

## Privacy and connectivity

- No GPS or custom location asset.
- Offline bot play requires no account, analytics, advertising, or developer-run service.
- Optional **JOIN SESSION** multiplayer uses SyncKit 4.0.0 to synchronize cells, presence, and deaths through Snap's Connected Lenses service.
- Original locally synthesized audio.

## Project layout

```text
Trailbound.esproj
Assets/
  Scene.scene
  Art/
    Meshes/                 # Shared primitive geometry
    Materials/              # PBR materials with emissive accents
    Textures/               # Surface variation and bevel normals
  Audio/                    # Original capture, cut, and death cues
  Scripts/
    Core/
      GridLogic.ts          # Platform-independent typed rules
      ArenaView.ts          # Batched world rendering and effects
      ConnectedGameSync.ts  # Shared cells, deaths, and session presence
    Game/
      TrailboundController.ts
    UI/
      WorldPanel.ts         # UIKit world-space panel and buttons
    Tests/
      GridLogic.test.ts     # Native Node TypeScript tests
      NodeAssert.d.ts
Packages/
  InteractionKit.lspkg      # 4.0.0
  UIKit.lspkg               # 4.0.0
  Motion.lspkg              # 4.0.0
  Icons.lspkg               # 4.0.0
  SyncKit.lspkg            # 4.0.0
Submission/
  Branding/                 # Store icon and media, kept outside the Lens build
```

## Tests

Requires Node 25 or newer; no npm dependencies.

```bash
npm test
```

The suite covers home spawning, loop closure and interior fill, self-collision, trail cuts, out-of-bounds death, respawning, and a deterministic 90-second four-player simulation.

## Development notes

- All application code is TypeScript. JavaScript is not used.
- UI uses UIKit `Button`, `ElementContent`, and `FlexLayout` with a world-space PBR backing panel.
- The arena anchors to the current head pose. Reset the Preview camera before refreshing if you do not want to move it.
- Preview uses an automatic cyan pilot via `global.deviceInfoSystem.isEditor()`.
- Preserve the 3 × 3 m arena, safety panel, visible version, and first-loop guide.
- Do not add location modules, location assets, or remote APIs (multiplayer uses SyncKit).

## Verification status

- TypeScript rules tests: **7/7 passing**.
- Lens TypeScript compilation and UIKit startup were exercised during the rebuild.
- Full interaction and on-device verification remain pending; see `SUBMISSION.md`.

## Attribution

Trailbound is a new implementation, not a source or asset copy. Mechanics were studied from the public `gjGameJam/PapAR` repository. See `NOTICE.md` and `LICENSE-upstream.md`.
