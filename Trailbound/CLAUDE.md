@AGENTS.md

## Trailbound project notes

- Application code is **TypeScript only**. Keep game rules in `Assets/Scripts/Core/GridLogic.ts` independent of Lens APIs and run `npm test` after rules changes.
- Required runtime packages are **Interaction Kit 4.0**, **UIKit 4.0**, **Motion 4.0**, and **Icons 4.0**. Preview-only agent helpers and `Plugins/` are not part of the Lens.
- The HUD is a world-space UIKit panel. Do not add an orthographic camera or screen-space overlay.
- UIKit layout uses `FlexLayout`/`FlexItem` and explicit `ElementContent.sizeOverride`; do not position rows with absolute X/Y offsets.
- The arena is 11 × 11 cells at 60% scale (≈3 × 3 m), placed on the real floor via a World Query hit test (head-height fallback in the editor). The first player to join a SyncKit session publishes the arena origin and everyone else adopts it. Reset Preview camera position before refreshing unless intentionally moving the arena.
- Preview uses an automatic cyan pilot via `global.deviceInfoSystem.isEditor()`. Physical Spectacles always use device movement and pinch-to-start.
- Preserve the 3 × 3 m arena, safety panel, visible version, and first-loop guide.
- Multiplayer is SyncKit 4.0 (`Packages/SyncKit.lspkg`, imported from the Asset Library, never renamed). Keep the SyncKit `Examples` object disabled and Start Mode `OFF` (our JOIN button starts multiplayer). Do not add location modules, location assets, or remote APIs.
- Design rules: all UI is UIKit; menus and HUD live in a UIKit `Frame` with tag-along (≈90–110 cm, ~30 cm wide); buttons are at least 16 × 5 cm; use theme text colours (only per-player colours are overridden); never hand-roll panel backing or follow code.
- Keep `Assets/` tidy: `Art/{Materials,Meshes,Shaders,Textures}`, `Audio/`, `Rendering/`, `Scripts/{Core,Game,Tests,UI}`, `Scene.scene`. No loose files at the root and no duplicate assets.
- Audio objects are cleaned up only by the timed cleanup loop; do not add a second destroy callback.
- `AiPreviewAgentInteract` is excluded from TypeScript compilation because that preview helper is incompatible with the current IK/Leaf declarations. It is not a runtime dependency.
