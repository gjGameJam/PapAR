# Trailbound — SPECS publishing checklist

Based on `Snapchat/lens-studio-docs`: `publishing-lens.mdx`, `submission-guidelines.md`, `optimizing-lens-performance.mdx`, `texture-optimization.md`, and `3d-meshes.md`.

## Build requirements

- [x] Target Platform is **SPECS**.
- [x] Application code is TypeScript.
- [x] No Experimental APIs, GPS/location modules, custom location assets, or developer-run remote APIs.
- [x] Optional Connected Lens sessions use SyncKit 4.0.0; offline bot play works without a session.
- [x] Custom Lens icon attached in Project Info.
- [x] Preview video attached in Project Info.
- [x] Version shown at launch and logged as `Lens Opened: v1.0.0`.
- [x] Package ID: `com.agrancinisc.trailbound`.
- [x] Build version: `1.0.0`.
- [ ] Production signing key assigned in SPK Settings.
- [ ] All items under **Please fix the following settings before publishing** are clear.
- [ ] Export uploaded and **Validated** in the SPECS Developer Portal.

## Size and performance

- Published build must be **25 MB or less**; Lens Studio recommends **under 6 MB**.
- Target **45 FPS** on physical SPECS, not just desktop Preview.
- Arena uses one static grid mesh and four dynamic batches per player instead of hundreds of individual cell visuals.
- Claims and trails use lightweight unlit materials. PBR is limited to the board backing.
- Procedural PBR textures are 64×64; keep all textures ≤512×512.
- Store media lives under `Submission/`, outside the Lens's `Assets/` directory.
- Required runtime packages: Interaction Kit, UIKit, Motion, and Icons 4.0.0, plus SyncKit 4.0.0 for optional multiplayer. Preview-only agent helpers are excluded from the public repo.
- [ ] Measure FPS, CPU, GPU, memory, and throttling with Lens Performance Overlay or SPECS Monitor on device.

## Store listing

- Description: at least 10 characters (use `SUBMISSION.md`).
- At least one preview image or video in Store Media.
- Suggested tags: **#Offline Mode**, **#Beginner Lenses**, **#World-Based**.
- Choose the closest available game Primary Category.
- Suggested age rating: **13+**.
- Suggested distribution: submit an **Internal** release first, then Public after device validation.
- Store media uses bright gameplay imagery with no stock assets and minimal text.

## Public-release legal documents

A Public release requires a Privacy Policy and Terms of Service as HTTPS links or text under **Settings > Legal documents**. `PRIVACY.md` and `TERMS.md` are provided as paste-ready starting points. Internal releases do not require them.

## Required testing before resubmission

1. Complete one full round on physical Spectacles.
2. Pinch START and REPLAY.
3. Walk a loop, capture territory, cut a bot trail, self-collide, leave the arena, and respawn.
4. Confirm movement alignment and readability in a clear 3 × 3 m space.
5. Check audio volume and first-round coach prompts.
6. Record FPS and thermal behavior with the on-device tools.
7. Record final preview media on hardware and attach it to the release.
8. With two devices, choose **JOIN SESSION** and verify slot assignment, shared claims/trails, deaths, departure cleanup, and solo fallback after one device leaves.
9. Paste the test steps and results into the submission notes.
