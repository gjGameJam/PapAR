# Trailbound — Lens submission notes

## Public description

Claim your corner of the room. Walk a loop, return to your cyan home, and fill the territory inside. Cut rival trails, but do not cross your own. Play against three lively bots or join friends in a shared arena. Trailbound is a fast 90-second spatial strategy game made for Spectacles.

## Short description

Walk loops. Claim territory. Cut rival trails. A 90-second solo AR game for Spectacles.

## Release notes — v1.0.0

- New ground-up Spectacles experience.
- Solo play against three local bot rivals with distinct pacing.
- Optional Connected Lens multiplayer with SyncKit 4.0.0: shared claims and trails, presence, deaths, and departure cleanup.
- Loop closure and enclosed-territory capture.
- Trail cuts, self-collision, out-of-bounds deaths, and three-second respawns.
- 90-second rounds with live scores and automatic rematches.
- First-loop visual guide, safety onboarding, original sound cues, and a custom icon.
- Offline play: no GPS, Connected Lens, remote API, or account required.

## Reviewer test notes

1. Launch the Lens and read the world-space safety panel. It explains the objective and asks for a clear 3 × 3 m space.
2. Pinch **START**. After the three-second countdown, leave the cyan home, walk a small loop, and return. The trail converts and enclosed cells fill.
3. Cross a pink, amber, or lime trail to cut its owner. Do not cross your own cyan trail.
4. If eliminated, remain on open ground. Respawn takes three seconds; blocked cells show guidance.
5. The round ends after 90 seconds. Final rankings appear; pinch **REPLAY** for another round.
6. No pairing, second player, network connection, location permission, or account is required for offline play.
7. Optional: on two devices, choose **JOIN SESSION**. Verify a remote player replaces a bot, claims and trails match on both screens, and leaving one device clears its trail.
8. On one device, choose **START SOLO** to confirm the offline bot fallback still works.

### Lens Studio Preview

The cyan player uses an automatic pilot in Preview. Bots move, capture, cut trails, die, and respawn, so a complete round can be reviewed on a desktop.

## Suggested tags

#Offline Mode, #Beginner Lenses, #World-Based

## Package and distribution

- Package ID: `com.agrancinisc.trailbound`
- Build version: `1.0.0`
- Submit an **Internal** release first, then Public after device validation.
- Public releases require legal documents; paste-ready starting points are in `PRIVACY.md` and `TERMS.md`.
- Full checklist: `PUBLISHING.md`.

## Before submitting

- [ ] Open in Lens Studio 5.25 and confirm the Lens name is **Trailbound**.
- [ ] Confirm `TRAILBOUND v1.0.0` appears at launch and during play.
- [ ] Confirm the custom icon and 3×4 preview artwork appear in Project Info.
- [ ] Deploy to physical Spectacles and complete one full round.
- [ ] Verify walking direction and cell alignment in a clear 3 × 3 m space.
- [ ] Verify loop capture, trail cut, self-collision, out-of-bounds handling, and respawn on device.
- [ ] Verify audio at a comfortable volume.
- [ ] Record the final preview on physical hardware.
- [ ] Paste the public description, release notes, and reviewer notes above.

## Publishing safety notes

The project intentionally contains no location-permission modules or location assets. Multiplayer uses SyncKit (Connected Lens); review Snap's publication rules before adding anything else. The safety card and 3 × 3 m arena are part of the experience; do not remove them to speed up onboarding.
