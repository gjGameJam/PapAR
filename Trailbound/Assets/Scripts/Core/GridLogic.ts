export const GRID_SIZE = 11
export const ROUND_SECONDS = 90
export const RESPAWN_SECONDS = 3

export interface Cell {
  x: number
  y: number
}

export type DeathCause = "self" | "cut" | "bounds" | "leave"

export interface PlayerInfo {
  name: string
  speed: number
  targetTrail: number
  aggression: number
}

export interface PlayerState extends PlayerInfo {
  id: number
  spawn: Cell
  pos: Cell
  previousPos: Cell
  alive: boolean
  respawnRemaining: number
  trail: number[]
  kills: number
  deaths: number
  captures: number
  moveCooldown: number
}

export type GameEvent =
  | {type: "trail"; player: number; cell: Cell}
  | {type: "capture"; player: number; cells: number; enclosed: number}
  | {type: "death"; victim: number; killer: number; cause: DeathCause}
  | {type: "respawn"; player: number; cell: Cell}

export interface LeaderboardEntry {
  id: number
  name: string
  score: number
  claims: number
  kills: number
  alive: boolean
}

export const PLAYER_INFO: PlayerInfo[] = [
  {name: "YOU", speed: 0.48, targetTrail: 10, aggression: 0},
  {name: "VEX", speed: 0.56, targetTrail: 12, aggression: 0.55},
  {name: "NOVA", speed: 0.64, targetTrail: 9, aggression: 0.25},
  {name: "MOSS", speed: 0.72, targetTrail: 7, aggression: 0.1},
]

const HOME_OFFSETS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]

export function indexOf(x: number, y: number, size: number): number {
  return y * size + x
}

export function inBounds(x: number, y: number, size: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size
}

export function neighbors(x: number, y: number, size: number): Cell[] {
  const result: Cell[] = []
  if (x > 0) result.push({x: x - 1, y})
  if (x + 1 < size) result.push({x: x + 1, y})
  if (y > 0) result.push({x, y: y - 1})
  if (y + 1 < size) result.push({x, y: y + 1})
  return result
}

export function bresenham(x0: number, y0: number, x1: number, y1: number): Cell[] {
  const cells: Cell[] = []
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  while (true) {
    cells.push({x, y})
    if (x === x1 && y === y1) break
    const e2 = err * 2
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
  return cells
}

/** Platform-independent rules. No Lens APIs are referenced in this module. */
export class TrailboundGame {
  readonly size: number
  claims: Int16Array
  trails: Int16Array
  players: PlayerState[]
  roundRemaining = ROUND_SECONDS
  elapsed = 0
  events: GameEvent[] = []
  private seed: number
  private randomState: number

  constructor(size = GRID_SIZE, seed = 0x71b0ad) {
    this.size = size
    this.seed = seed >>> 0
    this.randomState = this.seed || 1
    this.claims = new Int16Array(size * size)
    this.trails = new Int16Array(size * size)
    this.players = []
    this.reset()
  }

  reset(): void {
    this.claims.fill(-1)
    this.trails.fill(-1)
    this.events = []
    this.roundRemaining = ROUND_SECONDS
    this.elapsed = 0
    this.randomState = this.seed || 1
    const c = Math.floor(this.size / 2)
    const spawns: Cell[] = [
      {x: c, y: c},
      {x: this.size - 3, y: 2},
      {x: this.size - 3, y: this.size - 3},
      {x: 2, y: this.size - 3},
    ]
    this.players = PLAYER_INFO.map((info, id): PlayerState => ({
      ...info,
      id,
      spawn: {...spawns[id]},
      pos: {...spawns[id]},
      previousPos: {...spawns[id]},
      alive: true,
      respawnRemaining: 0,
      trail: [],
      kills: 0,
      deaths: 0,
      captures: 0,
      moveCooldown: id * 0.17,
    }))
    for (const player of this.players) this.claimHome(player.id, player.spawn)
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 4294967296
  }

  isOpenSpawn(x: number, y: number): boolean {
    if (!inBounds(x, y, this.size)) return false
    const i = indexOf(x, y, this.size)
    return this.claims[i] < 0 && this.trails[i] < 0
  }

  nearestOpenSpawn(center: Cell): Cell {
    let best: Cell | null = null
    let bestDistance = Infinity
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isOpenSpawn(x, y)) continue
        const distance = Math.abs(x - center.x) + Math.abs(y - center.y)
        if (distance < bestDistance) {
          bestDistance = distance
          best = {x, y}
        }
      }
    }
    return best ?? {...center}
  }

  claimHome(playerId: number, center: Cell): number {
    let claimed = 0
    for (const [dx, dy] of HOME_OFFSETS) {
      const x = center.x + dx
      const y = center.y + dy
      if (!inBounds(x, y, this.size)) continue
      const i = indexOf(x, y, this.size)
      if (this.trails[i] >= 0 && this.trails[i] !== playerId) continue
      if (this.claims[i] >= 0 && this.claims[i] !== playerId) continue
      if (this.claims[i] !== playerId) claimed++
      this.claims[i] = playerId
      if (this.trails[i] === playerId) this.trails[i] = -1
    }
    return claimed
  }

  /**
   * Move a player's starting home to `cell` (e.g. where they physically stand).
   * Clamps away from the arena edge so the 5-cell home fits, falls back to the
   * nearest open cell, and removes the player's previous default home.
   */
  relocateHome(playerId: number, cell: Cell): Cell {
    const player = this.players[playerId]
    const clamped = {
      x: Math.min(this.size - 2, Math.max(1, cell.x)),
      y: Math.min(this.size - 2, Math.max(1, cell.y)),
    }
    for (let i = 0; i < this.claims.length; i++) {
      if (this.claims[i] === playerId) this.claims[i] = -1
      if (this.trails[i] === playerId) this.trails[i] = -1
    }
    const target = this.isOpenSpawn(clamped.x, clamped.y) ? clamped : this.nearestOpenSpawn(clamped)
    player.spawn = {...target}
    player.pos = {...target}
    player.previousPos = {...target}
    player.trail = []
    this.claimHome(playerId, target)
    return target
  }

  respawn(playerId: number, preferredCell?: Cell | null): void {
    const player = this.players[playerId]
    const preferred = preferredCell && this.isOpenSpawn(preferredCell.x, preferredCell.y)
      ? preferredCell
      : null
    const target = preferred ?? this.nearestOpenSpawn(player.spawn)
    player.pos = {...target}
    player.previousPos = {...target}
    player.alive = true
    player.respawnRemaining = 0
    player.trail = []
    player.moveCooldown = 0.35
    this.claimHome(playerId, target)
    this.events.push({type: "respawn", player: playerId, cell: {...target}})
  }

  killPlayer(victimId: number, killerId: number, cause: DeathCause): void {
    const victim = this.players[victimId]
    if (!victim?.alive) return
    for (let i = 0; i < this.claims.length; i++) {
      if (this.claims[i] === victimId) this.claims[i] = -1
      if (this.trails[i] === victimId) this.trails[i] = -1
    }
    victim.alive = false
    victim.respawnRemaining = RESPAWN_SECONDS
    victim.trail = []
    victim.deaths++
    victim.moveCooldown = 0
    if (killerId !== victimId && this.players[killerId]) this.players[killerId].kills++
    this.events.push({type: "death", victim: victimId, killer: killerId, cause})
  }

  moveAlong(playerId: number, targetX: number, targetY: number): void {
    const player = this.players[playerId]
    if (!player?.alive) return
    const path = bresenham(player.pos.x, player.pos.y, targetX, targetY)
    for (let i = 1; i < path.length; i++) {
      this.movePlayer(playerId, path[i].x, path[i].y)
      if (!player.alive) break
    }
  }

  movePlayer(playerId: number, x: number, y: number): void {
    const player = this.players[playerId]
    if (!player?.alive || this.roundRemaining <= 0) return
    if (!inBounds(x, y, this.size)) {
      this.killPlayer(playerId, playerId, "bounds")
      return
    }
    if (player.pos.x === x && player.pos.y === y) return
    const i = indexOf(x, y, this.size)
    player.previousPos = {...player.pos}
    player.pos = {x, y}

    const trailOwner = this.trails[i]
    if (trailOwner >= 0) {
      if (trailOwner === playerId && this.claims[i] !== playerId) {
        this.killPlayer(playerId, playerId, "self")
        return
      }
      if (trailOwner !== playerId) this.killPlayer(trailOwner, playerId, "cut")
    }

    if (this.claims[i] === playerId) {
      if (player.trail.length > 0) this.closeLoop(playerId)
      return
    }
    this.trails[i] = playerId
    player.trail.push(i)
    this.events.push({type: "trail", player: playerId, cell: {x, y}})
  }

  closeLoop(playerId: number): void {
    const player = this.players[playerId]
    const trailCells = [...player.trail]
    if (trailCells.length === 0) return
    let newlyClaimed = 0
    for (const i of trailCells) {
      if (this.claims[i] !== playerId) newlyClaimed++
      this.claims[i] = playerId
      if (this.trails[i] === playerId) this.trails[i] = -1
    }
    player.trail = []

    const exterior = new Uint8Array(this.claims.length)
    const queue: Cell[] = []
    const enqueue = (x: number, y: number): void => {
      if (!inBounds(x, y, this.size)) return
      const i = indexOf(x, y, this.size)
      if (exterior[i] || this.claims[i] === playerId) return
      exterior[i] = 1
      queue.push({x, y})
    }
    for (let n = 0; n < this.size; n++) {
      enqueue(n, 0)
      enqueue(n, this.size - 1)
      enqueue(0, n)
      enqueue(this.size - 1, n)
    }
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head]
      for (const next of neighbors(cell.x, cell.y, this.size)) enqueue(next.x, next.y)
    }

    let enclosed = 0
    for (let i = 0; i < this.claims.length; i++) {
      if (this.claims[i] !== playerId && !exterior[i]) {
        this.claims[i] = playerId
        enclosed++
        newlyClaimed++
      }
    }
    player.captures++
    this.events.push({type: "capture", player: playerId, cells: newlyClaimed, enclosed})
  }

  private findPath(playerId: number, predicate: (index: number) => boolean, avoidOwnTrail = true): Cell[] {
    const player = this.players[playerId]
    const start = indexOf(player.pos.x, player.pos.y, this.size)
    const previous = new Int32Array(this.size * this.size)
    previous.fill(-2)
    previous[start] = -1
    const queue = [start]
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]
      const x = current % this.size
      const y = Math.floor(current / this.size)
      if (current !== start && predicate(current)) {
        const path: Cell[] = []
        let cursor = current
        while (cursor !== start && cursor >= 0) {
          path.push({x: cursor % this.size, y: Math.floor(cursor / this.size)})
          cursor = previous[cursor]
        }
        return path.reverse()
      }
      for (const next of neighbors(x, y, this.size)) {
        const ni = indexOf(next.x, next.y, this.size)
        if (previous[ni] !== -2) continue
        if (avoidOwnTrail && this.trails[ni] === playerId && this.claims[ni] !== playerId) continue
        previous[ni] = current
        queue.push(ni)
      }
    }
    return []
  }

  private pathHome(playerId: number): Cell[] {
    return this.findPath(playerId, (i) => this.claims[i] === playerId)
  }

  private nearestEnemyTrail(playerId: number, maxDistance: number): number {
    const player = this.players[playerId]
    let best = -1
    let bestDistance = maxDistance + 1
    for (let i = 0; i < this.trails.length; i++) {
      const owner = this.trails[i]
      if (owner < 0 || owner === playerId || !this.players[owner].alive) continue
      const distance = Math.abs((i % this.size) - player.pos.x) +
        Math.abs(Math.floor(i / this.size) - player.pos.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    return best
  }

  private chooseBotMove(playerId: number): Cell | null {
    const player = this.players[playerId]
    const p = player.pos
    if (player.trail.length >= player.targetTrail) {
      const home = this.pathHome(playerId)
      if (home.length > 0) return home[0]
    }
    if (player.aggression > 0 && this.random() < player.aggression) {
      const target = this.nearestEnemyTrail(playerId, 5)
      if (target >= 0) {
        const path = this.findPath(playerId, (i) => i === target)
        if (path.length > 0 && path.length <= 5) return path[0]
      }
    }
    if (player.trail.length >= 4 && this.random() < 0.14) {
      const home = this.pathHome(playerId)
      if (home.length > 0) return home[0]
    }

    const options = neighbors(p.x, p.y, this.size).filter((cell) => {
      const i = indexOf(cell.x, cell.y, this.size)
      return this.trails[i] !== playerId && this.claims[i] !== playerId
    })
    if (options.length === 0) {
      const home = this.pathHome(playerId)
      if (home.length > 0) return home[0]
      const safe = neighbors(p.x, p.y, this.size).filter((cell) =>
        this.trails[indexOf(cell.x, cell.y, this.size)] !== playerId)
      return safe.length > 0 ? safe[Math.floor(this.random() * safe.length)] : null
    }

    const dx = p.x - player.previousPos.x
    const dy = p.y - player.previousPos.y
    let best = options[0]
    let bestScore = -Infinity
    for (const cell of options) {
      const i = indexOf(cell.x, cell.y, this.size)
      const continues = cell.x - p.x === dx && cell.y - p.y === dy ? 1.1 : 0
      const unclaimed = this.claims[i] < 0 ? 0.8 : 0
      const homeDistance = Math.abs(cell.x - player.spawn.x) + Math.abs(cell.y - player.spawn.y)
      const outward = player.trail.length < 4 ? homeDistance * 0.09 : 0
      const score = continues + unclaimed + outward + this.random() * 1.4
      if (score > bestScore) {
        bestScore = score
        best = cell
      }
    }
    return best
  }

  update(
    dt: number,
    autoHuman = false,
    humanCell: Cell | null = null,
    automatedOverride?: boolean[],
    remoteSlots?: boolean[]
  ): void {
    if (dt <= 0 || this.roundRemaining <= 0) return
    this.elapsed += dt
    this.roundRemaining = Math.max(0, this.roundRemaining - dt)
    for (const player of this.players) {
      // Players driven by another device: their device moves and respawns them.
      if (remoteSlots?.[player.id]) continue
      const automated = automatedOverride ? automatedOverride[player.id] : player.id !== 0 || autoHuman
      if (!player.alive) {
        if (!automated && humanCell && !this.isOpenSpawn(humanCell.x, humanCell.y)) {
          player.respawnRemaining = RESPAWN_SECONDS
          continue
        }
        player.respawnRemaining = Math.max(0, player.respawnRemaining - dt)
        if (player.respawnRemaining <= 0) this.respawn(player.id, automated ? player.spawn : humanCell)
        continue
      }
      if (!automated) continue
      player.moveCooldown -= dt
      if (player.moveCooldown > 0) continue
      player.moveCooldown = player.speed
      const next = this.chooseBotMove(player.id)
      if (next) this.movePlayer(player.id, next.x, next.y)
    }
  }

  claimsCount(playerId: number): number {
    let count = 0
    for (const owner of this.claims) if (owner === playerId) count++
    return count
  }

  score(playerId: number): number {
    return this.claimsCount(playerId) * 10 + this.players[playerId].kills * 50
  }

  leaderboard(): LeaderboardEntry[] {
    return this.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: this.score(player.id),
      claims: this.claimsCount(player.id),
      kills: player.kills,
      alive: player.alive,
    })).sort((a, b) => b.score - a.score || a.id - b.id)
  }

  drainEvents(): GameEvent[] {
    const result = this.events
    this.events = []
    return result
  }
}
