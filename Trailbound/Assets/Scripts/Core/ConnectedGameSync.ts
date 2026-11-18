import {SessionController} from "SyncKit.lspkg/Core/SessionController"
import {SyncEntity} from "SyncKit.lspkg/Core/SyncEntity"
import {StorageProperty} from "SyncKit.lspkg/Core/StorageProperty"
import {StorageTypes} from "SyncKit.lspkg/Core/StorageTypes"
import type {DeathCause, TrailboundGame} from "./GridLogic"

const SLOT_COUNT = 4
const ORIGIN_UNSET_Y = -99999

@component
export class ConnectedGameSync extends BaseScriptComponent {
  @input enabled = true

  onCellChanged: ((index: number, claim: number, trail: number) => void) | null = null
  onPresenceChanged: ((slots: boolean[]) => void) | null = null
  onRemoteDeath: ((victim: number, killer: number, cause: DeathCause) => void) | null = null
  /** Called when the session's shared arena origin (world space, cm) is set or changes. */
  onOriginChanged: ((origin: vec3) => void) | null = null
  /** Asked once the session is ready; return this device's arena origin to publish it, or null. */
  getLocalOrigin: (() => vec3 | null) | null = null

  private entity: SyncEntity | null = null
  private properties: StorageProperty<StorageTypes.vec2>[] = []
  private slotProperties: StorageProperty<StorageTypes.string>[] = []
  private originProperty: StorageProperty<StorageTypes.vec3> | null = null
  private lastClaims = new Int16Array(121)
  private lastTrails = new Int16Array(121)
  private localSlot = 0
  private connectedSlots = [true, false, false, false]
  private appliedOrigin: vec3 | null = null
  private ready = false

  onAwake(): void {
    if (!this.enabled) return
    this.lastClaims.fill(-2)
    this.lastTrails.fill(-2)
    this.entity = new SyncEntity(this)
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        const index = y * 11 + x
        const property = StorageProperty.manualVec2(`cell_${x}_${y}`, new vec2(-1, -1))
        this.entity.addStorageProperty(property)
        property.onAnyChange.add((value, _previous, _updateInfo) => {
          if (!value) return
          const claim = Math.round(value.x)
          const trail = Math.round(value.y)
          this.lastClaims[index] = claim
          this.lastTrails[index] = trail
          this.onCellChanged?.(index, claim, trail)
        })
        this.properties[index] = property
      }
    }

    // One claimed slot per player. Slots hold a user id and stay put when others join.
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const property = StorageProperty.manualString(`slot_${slot}`, "")
      this.entity.addStorageProperty(property)
      property.onAnyChange.add(() => {
        if (this.ready) this.refreshPresence()
      })
      this.slotProperties[slot] = property
    }

    // Shared arena origin: the first player to join publishes it, everyone else adopts it.
    const origin = StorageProperty.manualVec3("arena_origin", new vec3(0, ORIGIN_UNSET_Y, 0))
    this.entity.addStorageProperty(origin)
    origin.onAnyChange.add((value) => {
      if (value && this.isOriginSet(value)) this.applyOrigin(value)
    })
    this.originProperty = origin

    this.entity.onSetupFinished.add(() => {
      this.ready = true
      this.adoptOrPublishOrigin()
      this.claimSlot()
      this.refreshPresence()
    })
    this.entity.onRemoteEventReceived.add("death", (message) => {
      const data = message.data as {victim: number; killer: number; cause: DeathCause}
      this.onRemoteDeath?.(data.victim, data.killer, data.cause)
    })

    const session = SessionController.getInstance()
    session.onUserJoinedSession.add(() => this.refreshPresence())
    session.onUserLeftSession.add((_session, userInfo) => {
      this.releaseSlotsOf(userInfo?.userId ?? "")
      this.refreshPresence()
    })
  }

  private isOriginSet(value: vec3): boolean {
    return value.y > ORIGIN_UNSET_Y + 1
  }

  private applyOrigin(value: vec3): void {
    const previous = this.appliedOrigin
    if (previous && previous.distance(value) < 0.01) return
    this.appliedOrigin = new vec3(value.x, value.y, value.z)
    this.onOriginChanged?.(this.appliedOrigin)
  }

  private adoptOrPublishOrigin(): void {
    const property = this.originProperty
    if (!property) return
    const shared = property.currentOrPendingValue
    if (shared && this.isOriginSet(shared)) {
      this.applyOrigin(shared)
      return
    }
    const local = this.getLocalOrigin?.() ?? null
    if (!local) return
    property.setPendingValue(new vec3(local.x, local.y, local.z))
    this.appliedOrigin = new vec3(local.x, local.y, local.z)
  }

  private localUserId(): string {
    return SessionController.getInstance().getLocalUserInfo()?.userId ?? ""
  }

  private presentUserIds(): string[] {
    return SessionController.getInstance().getUsers()
      .filter((user) => user && user.userId)
      .map((user) => user.userId)
  }

  private slotValue(slot: number): string {
    return this.slotProperties[slot]?.currentOrPendingValue ?? ""
  }

  /** Take (or keep) a slot for the local user. Slots of departed users are reusable. */
  private claimSlot(): void {
    const me = this.localUserId()
    if (!me) return
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (this.slotValue(slot) === me) {
        this.localSlot = slot
        return
      }
    }
    const present = this.presentUserIds()
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const holder = this.slotValue(slot)
      if (holder === "" || present.indexOf(holder) < 0) {
        this.slotProperties[slot].setPendingValue(me)
        this.localSlot = slot
        return
      }
    }
    // Session full: share the last slot locally without writing it.
    this.localSlot = SLOT_COUNT - 1
  }

  private releaseSlotsOf(userId: string): void {
    if (!userId || !this.ready) return
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (this.slotValue(slot) === userId) this.slotProperties[slot].setPendingValue("")
    }
  }

  private refreshPresence(): void {
    const me = this.localUserId()
    const present = this.presentUserIds()
    const previousSlots = [...this.connectedSlots]

    // If another client overwrote our slot in a simultaneous claim, pick again.
    if (this.ready && me && this.slotValue(this.localSlot) !== me) this.claimSlot()

    this.connectedSlots = [false, false, false, false]
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const holder = this.slotValue(slot)
      this.connectedSlots[slot] = holder !== "" && (holder === me || present.indexOf(holder) >= 0)
    }
    this.connectedSlots[this.localSlot] = true
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (previousSlots[slot] && !this.connectedSlots[slot] && slot !== this.localSlot) {
        this.onRemoteDeath?.(slot, slot, "leave")
      }
    }
    this.onPresenceChanged?.([...this.connectedSlots])
  }

  getLocalSlot(): number {
    return this.localSlot
  }

  getConnectedSlots(): boolean[] {
    return [...this.connectedSlots]
  }

  isReady(): boolean {
    return this.ready
  }

  syncAll(game: TrailboundGame): void {
    if (!this.ready) return
    for (let i = 0; i < game.claims.length; i++) {
      const claim = game.claims[i]
      const trail = game.trails[i]
      if (claim === this.lastClaims[i] && trail === this.lastTrails[i]) continue
      const property = this.properties[i]
      property.setPendingValue(new vec2(claim, trail))
      this.lastClaims[i] = claim
      this.lastTrails[i] = trail
    }
  }

  broadcastDeath(victim: number, killer: number, cause: DeathCause): void {
    if (!this.ready || !this.entity) return
    this.entity.sendEvent("death", {victim, killer, cause}, true)
  }
}
