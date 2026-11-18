import {ArenaView, CELL_SIZE} from "../Core/ArenaView"
import {ConnectedGameSync} from "../Core/ConnectedGameSync"
import {SessionController} from "SyncKit.lspkg/Core/SessionController"
import {
  Cell,
  GameEvent,
  LeaderboardEntry,
  TrailboundGame,
} from "../Core/GridLogic"
import {WorldPanel} from "../UI/WorldPanel"

const VERSION = "1.0.0"
// The arena is 11 x 11 cells. At 60% scale a cell is 27 cm, so the board is about
// 3 x 3 m: a normal room, big enough to walk, small enough not to dominate it.
const ARENA_SCALE = 0.6
const CELL_WORLD = CELL_SIZE * ARENA_SCALE
// Arena centre is placed this far ahead of the player (cm), flat on the floor.
const ARENA_DISTANCE = 170
// Used until the floor is detected (and in the editor): assumed head height above floor (cm).
const FALLBACK_EYE_HEIGHT = 155
const FLOOR_PROBE_INTERVAL = 0.4
const COUNTDOWN_SECONDS = 3
const EDITOR_RESTART_DELAY = 8

type Phase = "welcome" | "countdown" | "playing" | "roundOver"

interface AudioObject {
  object: SceneObject
  age: number
}

@component
export class TrailboundController extends BaseScriptComponent {
  @input playerTracker: DeviceTracking
  @input arenaRoot: SceneObject
  @input visualsRoot: SceneObject
  @input worldPanel: WorldPanel
  @input connectedSync: ConnectedGameSync
  @input boxMesh: RenderMesh
  @input sphereMesh: RenderMesh
  @input cylinderMesh: RenderMesh
  @input torusMesh: RenderMesh
  @input gridMaterial: Material
  @input boundaryMaterial: Material
  @input claimMaterials: Material[]
  @input trailMaterials: Material[]
  @input whiteMaterial: Material
  @input captureTrack: AudioTrackAsset
  @input deathTrack: AudioTrackAsset
  @input cutTrack: AudioTrackAsset
  @input autoStartInEditor = true

  private readonly previewPilot = global.deviceInfoSystem.isEditor()
  private game!: TrailboundGame
  private view!: ArenaView
  private phase: Phase = "welcome"
  private phaseRemaining = 0
  private origin: {x: number; y: number; z: number} | null = null
  private visualDirty = true
  private guideUsed = false
  private coachStage = 0
  private localPlayerId = 0
  private connectedSlots = [true, false, false, false]
  private automatedSlots = [false, true, true, true]
  private remoteSlots = [false, false, false, false]
  private floorSession: HitTestSession | null = null
  private floorLocked = false
  private floorFound = false
  private floorProbeCooldown = 0
  private applyingRemoteDeath = false
  private joinRequested = false
  private statusMessage = ""
  private statusRemaining = 0
  private hudCooldown = 0
  private countdownShown = -1
  private audioObjects: AudioObject[] = []

  onAwake(): void {
    this.game = new TrailboundGame(11, this.previewPilot ? 123456 : Date.now())
    this.view = new ArenaView({
      root: this.visualsRoot,
      box: this.boxMesh,
      sphere: this.sphereMesh,
      cylinder: this.cylinderMesh,
      torus: this.torusMesh,
      grid: this.gridMaterial,
      boundary: this.boundaryMaterial,
      claims: this.claimMaterials,
      trails: this.trailMaterials,
      white: this.whiteMaterial,
    })
    this.arenaRoot.getTransform().setLocalScale(new vec3(ARENA_SCALE, ARENA_SCALE, ARENA_SCALE))
    this.view.create()
    this.view.sync(this.game)
    this.visualsRoot.enabled = true
    this.worldPanel.onStartRequested = () => this.requestStart()
    this.worldPanel.onJoinRequested = () => this.requestJoin()
    this.connectedSync.onCellChanged = (index, claim, trail) => {
      this.game.claims[index] = claim
      this.game.trails[index] = trail
      // Only a trail cell marks where a remote player currently is; claim fills
      // land on arbitrary interior cells and must not move anyone.
      if (trail >= 0 && trail !== this.localPlayerId) {
        this.game.players[trail].pos = {x: index % 11, y: Math.floor(index / 11)}
      }
      this.visualDirty = true
    }
    this.connectedSync.onPresenceChanged = (slots) => {
      this.connectedSlots = slots
      this.localPlayerId = this.connectedSync.getLocalSlot()
      // The lowest connected slot is the host and the only client that simulates bots
      // for empty slots; everyone else treats those slots as remote and just mirrors
      // the synced cells, so bot writes never conflict.
      const hostSlot = Math.max(0, slots.indexOf(true))
      const isHost = this.localPlayerId === hostSlot
      for (let id = 0; id < 4; id++) {
        if (this.previewPilot) {
          this.automatedSlots[id] = true
          this.remoteSlots[id] = false
        } else if (id === this.localPlayerId) {
          this.automatedSlots[id] = false
          this.remoteSlots[id] = false
        } else if (slots[id]) {
          this.automatedSlots[id] = false
          this.remoteSlots[id] = true
        } else {
          this.automatedSlots[id] = isHost
          this.remoteSlots[id] = !isHost
        }
      }
      if (this.joinRequested && this.connectedSync.isReady() &&
        (this.phase === "welcome" || this.phase === "roundOver")) {
        this.joinRequested = false
        this.startCountdown()
      }
    }
    this.connectedSync.onRemoteDeath = (victim, killer, cause) => {
      this.game.killPlayer(victim, killer, cause)
      this.applyingRemoteDeath = true
      this.handleEvents(this.game.drainEvents())
      this.applyingRemoteDeath = false
      this.connectedSync.syncAll(this.game)
    }
    this.connectedSync.getLocalOrigin = () =>
      this.origin ? new vec3(this.origin.x, this.origin.y, this.origin.z) : null
    this.connectedSync.onOriginChanged = (shared) => this.applySharedOrigin(shared)
    this.createEvent("OnStartEvent").bind(() => {
      this.worldPanel.showWelcome()
      this.captureOrigin()
    })
    this.createEvent("UpdateEvent").bind((event) => this.update(event.getDeltaTime()))
    print(`Lens Opened: v${VERSION}`)
  }

  private requestStart(): void {
    if (this.phase === "welcome" || this.phase === "roundOver") this.startCountdown()
  }

  private requestJoin(): void {
    if (this.phase !== "welcome" && this.phase !== "roundOver") return
    this.joinRequested = true
    this.setStatus("JOINING SESSION…", 4)
    this.connectedSync.syncAll(this.game)
    SessionController.getInstance().startMultiplayer()
  }

  private startCountdown(): void {
    this.lockFloor()
    this.game.reset()
    this.game.drainEvents()
    this.placeLocalHome()
    this.visualDirty = true
    this.visualsRoot.enabled = true
    this.view.setGuideActive(this.localPlayerId === 0 && !this.guideUsed)
    this.phase = "countdown"
    this.phaseRemaining = COUNTDOWN_SECONDS
    this.countdownShown = -1
    this.worldPanel.showCountdown(COUNTDOWN_SECONDS)
  }

  private startRound(): void {
    this.phase = "playing"
    this.worldPanel.showHud()
    this.setStatus(this.previewPilot ? "PREVIEW PILOT  ·  WATCH CYAN" : "LEAVE HOME  ·  LOOP  ·  RETURN", 3)
    this.playTrack(this.captureTrack, 0.45)
    this.updateHud()
    print("Trailbound: round started")
  }

  private finishRound(): void {
    this.phase = "roundOver"
    this.phaseRemaining = EDITOR_RESTART_DELAY
    this.visualsRoot.enabled = false
    const leaders = this.game.leaderboard()
    this.worldPanel.showResults(leaders)
    print(`Trailbound: round over ${leaders.map((entry) => `${entry.name}=${entry.score}`).join(", ")}`)
  }

  private flatForward(): vec3 {
    const rotation = this.playerTracker.getTransform().getWorldRotation()
    const forward = rotation.multiplyVec3(new vec3(0, 0, -1))
    const flat = new vec3(forward.x, 0, forward.z)
    return flat.length > 0.001 ? flat.normalize() : new vec3(0, 0, -1)
  }

  private captureOrigin(): void {
    if (!this.playerTracker) return
    const position = this.playerTracker.getTransform().getWorldPosition()
    if (!isFinite(position.x) || !isFinite(position.y) || !isFinite(position.z)) return
    const forward = this.flatForward().uniformScale(ARENA_DISTANCE)
    this.setArenaCenter(new vec3(position.x + forward.x, position.y - FALLBACK_EYE_HEIGHT, position.z + forward.z))
  }

  private setArenaCenter(center: vec3): void {
    this.origin = {x: center.x, y: center.y, z: center.z}
    this.arenaRoot.getTransform().setWorldPosition(center)
    this.placeLocalHome()
    this.visualDirty = true
  }

  /**
   * Snap the arena onto the real floor: cast a ray straight down at the spot where the
   * arena will sit and keep the first roughly horizontal hit. Until a hit arrives the
   * fallback height from captureOrigin() is used.
   */
  private probeFloor(dt: number): void {
    if (this.floorLocked || this.previewPilot || !this.playerTracker) return
    this.floorProbeCooldown -= dt
    if (this.floorProbeCooldown > 0) return
    this.floorProbeCooldown = FLOOR_PROBE_INTERVAL
    try {
      if (!this.floorSession) {
        const module = require("LensStudio:WorldQueryModule") as WorldQueryModule
        const options = HitTestSessionOptions.create()
        options.filter = true
        this.floorSession = module.createHitTestSessionWithOptions(options)
        this.floorSession.start()
      }
      const head = this.playerTracker.getTransform().getWorldPosition()
      const forward = this.flatForward().uniformScale(ARENA_DISTANCE)
      const above = new vec3(head.x + forward.x, head.y, head.z + forward.z)
      this.floorSession.hitTest(above, above.add(new vec3(0, -400, 0)), (hit) => {
        if (!hit || this.floorLocked) return
        if (hit.normal.y < 0.8) return
        this.setArenaCenter(new vec3(hit.position.x, hit.position.y + 0.5, hit.position.z))
        this.floorFound = true
      })
    } catch (error) {
      this.floorLocked = true
      print(`Trailbound: floor detection unavailable (${error})`)
    }
  }

  private lockFloor(): void {
    this.floorLocked = true
    this.floorSession?.stop()
    this.floorSession = null
  }

  /** Adopt the session's shared arena origin so every player sees the same grid in the room. */
  private applySharedOrigin(shared: vec3): void {
    // Another player already set the arena up: use their spot and stop probing the floor.
    this.lockFloor()
    this.setArenaCenter(new vec3(shared.x, shared.y, shared.z))
  }

  private placeLocalHome(): void {
    if (this.previewPilot) return
    const cell = this.trackerCell()
    if (!cell) return
    this.game.relocateHome(this.localPlayerId, cell)
    this.visualDirty = true
  }

  private trackerCell(): Cell | null {
    if (!this.origin) return null
    const position = this.playerTracker.getTransform().getWorldPosition()
    return {
      x: Math.floor((position.x - this.origin.x) / CELL_WORLD + 5.5),
      y: Math.floor((position.z - this.origin.z) / CELL_WORLD + 5.5),
    }
  }

  private update(dt: number): void {
    if (!this.origin) this.captureOrigin()
    if (this.phase === "welcome") this.probeFloor(dt)
    if (this.statusRemaining > 0) this.statusRemaining -= dt
    this.hudCooldown -= dt

    if (this.phase === "welcome") {
      if (this.previewPilot && this.autoStartInEditor) {
        this.phaseRemaining += dt
        if (this.phaseRemaining >= 2) this.startCountdown()
      }
    } else if (this.phase === "countdown") {
      this.phaseRemaining -= dt
      const second = Math.ceil(this.phaseRemaining)
      if (second !== this.countdownShown) {
        this.countdownShown = second
        this.worldPanel.showCountdown(second)
      }
      if (this.phaseRemaining <= 0) this.startRound()
    } else if (this.phase === "playing") {
      const humanCell = this.trackerCell()
      if (!this.previewPilot && this.game.players[this.localPlayerId].alive && humanCell) {
        const human = this.game.players[this.localPlayerId]
        if (human.pos.x !== humanCell.x || human.pos.y !== humanCell.y) {
          this.game.moveAlong(this.localPlayerId, humanCell.x, humanCell.y)
        }
      }
      this.game.update(dt, this.previewPilot, humanCell, this.automatedSlots, this.remoteSlots)
      this.handleEvents(this.game.drainEvents())
      this.connectedSync.syncAll(this.game)
      if (this.game.roundRemaining <= 0) this.finishRound()
    } else if (this.phase === "roundOver" && this.previewPilot) {
      this.phaseRemaining -= dt
      if (this.phaseRemaining <= 0) this.startCountdown()
    }

    if (this.visualDirty) {
      this.view.sync(this.game)
      this.visualDirty = false
    }
    this.view.update(dt, this.game)
    this.updateAudio(dt)
    if (this.phase === "playing" && this.hudCooldown <= 0) {
      this.hudCooldown = 0.2
      this.updateHud()
    }
  }

  private handleEvents(events: GameEvent[]): void {
    if (events.length > 0) this.visualDirty = true
    for (const event of events) {
      if (event.type === "capture") {
        const name = this.game.players[event.player].name
        if (event.player === this.localPlayerId) {
          this.guideUsed = true
          this.coachStage = Math.max(this.coachStage, 3)
          this.view.setGuideActive(false)
          this.setStatus(`LOOP CLOSED  +${event.cells} CELLS`)
          this.playTrack(this.captureTrack)
        } else if (event.enclosed > 0) {
          this.setStatus(`${name} CLAIMED ${event.cells} CELLS`, 1.5)
        }
        this.view.burst(this.game, event.player, event.player === this.localPlayerId ? 12 : 6)
      } else if (event.type === "death") {
        if (!this.applyingRemoteDeath) {
          this.connectedSync.broadcastDeath(event.victim, event.killer, event.cause)
        }
        const victim = this.game.players[event.victim].name
        if (event.killer === this.localPlayerId && event.victim !== this.localPlayerId) {
          this.coachStage = Math.max(this.coachStage, 4)
          this.setStatus(`YOU CUT ${victim}'S TRAIL  +50`)
          this.playTrack(this.cutTrack)
        } else if (event.victim === this.localPlayerId) {
          if (event.cause === "self") this.setStatus("YOU CROSSED YOUR OWN TRAIL")
          else if (event.cause === "bounds") this.setStatus("ARENA EXIT — TRAIL LOST")
          else if (event.cause === "leave") this.setStatus("PLAYER LEFT — TRAIL CLEARED")
          else this.setStatus(`${this.game.players[event.killer].name} CUT YOUR TRAIL`)
          this.playTrack(this.deathTrack, 0.55)
        } else {
          this.setStatus(`${this.game.players[event.killer].name} CUT ${victim}`, 1.5)
        }
        this.view.burst(this.game, event.victim, 14)
      } else if (event.type === "respawn" && event.player === this.localPlayerId) {
        this.setStatus("BACK IN — BUILD A NEW LOOP")
      }
    }
  }

  private setStatus(message: string, seconds = 2.4): void {
    this.statusMessage = message
    this.statusRemaining = seconds
    this.hudCooldown = 0
    this.updateHud()
  }

  private defaultStatus(): string {
    const human = this.game.players[this.localPlayerId]
    if (!human.alive) {
      if (!this.previewPilot) {
        const cell = this.trackerCell()
        if (cell && !this.game.isOpenSpawn(cell.x, cell.y)) {
          const outside = cell.x < 0 || cell.y < 0 || cell.x >= this.game.size || cell.y >= this.game.size
          return outside ? "RETURN TO THE GLOWING ARENA" : "MOVE TO OPEN GROUND TO RESPAWN"
        }
      }
      return `RESPAWNING IN ${Math.max(1, Math.ceil(human.respawnRemaining))}`
    }
    if (this.coachStage === 0 && human.trail.length === 0) return "STEP 1  ·  WALK OUT OF YOUR CYAN HOME"
    if (this.coachStage <= 1 && human.trail.length < 3) return "STEP 2  ·  LOOP AROUND OPEN CELLS"
    if (this.coachStage <= 2 && human.trail.length >= 3) return "STEP 3  ·  RETURN TO CYAN TO CLAIM"
    if (this.coachStage === 3) return "NICE! NOW CUT A RIVAL'S BRIGHT TRAIL"
    return human.trail.length > 0
      ? `TRAIL ${human.trail.length}  ·  RETURN TO CYAN`
      : "LEAVE HOME  ·  LOOP  ·  RETURN"
  }

  private updateHud(): void {
    const seconds = Math.max(0, Math.ceil(this.game.roundRemaining))
    const timer = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    const scores = this.game.players.map((player) => this.game.score(player.id))
    const status = this.statusRemaining > 0 ? this.statusMessage : this.defaultStatus()
    this.worldPanel.updateHud(timer, scores, status, this.localPlayerId)
  }

  private playTrack(track: AudioTrackAsset, volume = 0.65): void {
    if (!track) return
    const object = global.scene.createSceneObject("Trailbound SFX")
    object.setParent(this.sceneObject)
    const audio = object.createComponent("Component.AudioComponent") as AudioComponent
    audio.audioTrack = track
    audio.volume = volume
    audio.playbackMode = Audio.PlaybackMode.LowLatency
    audio.play(1)
    this.audioObjects.push({object, age: 0})
  }

  private updateAudio(dt: number): void {
    for (let i = this.audioObjects.length - 1; i >= 0; i--) {
      this.audioObjects[i].age += dt
      if (this.audioObjects[i].age > 4) {
        this.audioObjects[i].object.destroy()
        this.audioObjects.splice(i, 1)
      }
    }
  }
}
