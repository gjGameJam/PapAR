import {TrailboundGame, indexOf} from "./GridLogic"

export const CELL_SIZE = 45

export interface ArenaAssets {
  root: SceneObject
  box: RenderMesh
  sphere: RenderMesh
  cylinder: RenderMesh
  torus: RenderMesh
  grid: Material
  boundary: Material
  claims: Material[]
  trails: Material[]
  white: Material
}

interface MeshView {
  object: SceneObject
  visual: RenderMeshVisual
}

interface MarkerView {
  root: SceneObject
  head: SceneObject
  ring: SceneObject
  target: vec3
}

interface BurstParticle {
  object: SceneObject
  velocity: vec3
  life: number
  maxLife: number
}

interface BatchedVisual {
  builder: MeshBuilder
  visual: RenderMeshVisual
  object: SceneObject
  vertices: number[]
  indices: number[]
}

function addTriangle(
  vertices: number[],
  indices: number[],
  a: vec3,
  b: vec3,
  c: vec3,
  uvA: vec2,
  uvB: vec2,
  uvC: vec2,
): void {
  const ab = b.sub(a)
  const ac = c.sub(a)
  const normal = ab.cross(ac).normalize()
  const center = a.add(b).add(c).uniformScale(1 / 3)
  const base = vertices.length / 8
  for (const [point, uv] of [[a, uvA], [b, uvB], [c, uvC]] as [vec3, vec2][]) {
    vertices.push(point.x, point.y, point.z, normal.x, normal.y, normal.z, uv.x, uv.y)
  }
  if (normal.dot(center) < 0) {
    indices.push(base, base + 2, base + 1)
  } else {
    indices.push(base, base + 1, base + 2)
  }
}

function addBox(vertices: number[], indices: number[], center: vec3, size: vec3): void {
  const x = size.x / 2
  const y = size.y / 2
  const z = size.z / 2
  const corners = [
    new vec3(-x, -y, -z), new vec3(x, -y, -z), new vec3(x, y, -z), new vec3(-x, y, -z),
    new vec3(-x, -y, z), new vec3(x, -y, z), new vec3(x, y, z), new vec3(-x, y, z),
  ].map((point) => point.add(center))
  const faces = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3],
    [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2],
  ]
  const uvs = [new vec2(0, 0), new vec2(1, 0), new vec2(1, 1), new vec2(0, 1)]
  for (const [a, b, c, d] of faces) {
    const first = vertices.length / 8
    for (let i = 0; i < 4; i++) {
      const index = [a, b, c, d][i]
      const point = corners[index]
      const normal = index === 0 || index === 3 || index === 4 || index === 7 ? -1 : 1
      vertices.push(point.x, point.y, point.z, normal, normal, normal, uvs[i].x, uvs[i].y)
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }
}

function addOctahedron(vertices: number[], indices: number[], center: vec3, radius: number): void {
  const top = center.add(new vec3(0, radius, 0))
  const bottom = center.add(new vec3(0, -radius, 0))
  const ring = [
    center.add(new vec3(radius, 0, 0)),
    center.add(new vec3(0, 0, radius)),
    center.add(new vec3(-radius, 0, 0)),
    center.add(new vec3(0, 0, -radius)),
  ]
  for (let i = 0; i < 4; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % 4]
    addTriangle(vertices, indices, top, a, b, new vec2(0.5, 1), new vec2(0, 0), new vec2(1, 0))
    addTriangle(vertices, indices, bottom, b, a, new vec2(0.5, 0), new vec2(0, 1), new vec2(1, 1))
  }
}

function makeBuilder(layout: any[]): MeshBuilder {
  const builder = new MeshBuilder(layout)
  builder.topology = MeshTopology.Triangles
  builder.indexType = MeshIndexType.UInt16
  return builder
}

export class ArenaView {
  private markers: MarkerView[] = []
  private guideDots: SceneObject[] = []
  private particles: BurstParticle[] = []
  private claimBase: BatchedVisual[] = []
  private claimCap: BatchedVisual[] = []
  private trailPylon: BatchedVisual[] = []
  private trailOrb: BatchedVisual[] = []
  private lastClaims = new Int16Array(121)
  private lastTrails = new Int16Array(121)
  private elapsed = 0
  private guideActive = true

  constructor(private assets: ArenaAssets) {}

  create(): void {
    this.lastClaims.fill(-2)
    this.lastTrails.fill(-2)
    this.createGrid()
    for (let id = 0; id < 4; id++) {
      this.claimBase[id] = this.createBatch(`Claim base ${id}`, this.assets.claims[id])
      this.claimCap[id] = this.createBatch(`Claim cap ${id}`, this.assets.trails[id])
      this.trailPylon[id] = this.createBatch(`Trail pylon ${id}`, this.assets.trails[id])
      this.trailOrb[id] = this.createBatch(`Trail orb ${id}`, this.assets.trails[id])
    }

    const length = 11 * CELL_SIZE + 8
    const edge = 11 * CELL_SIZE / 2 + 2
    this.mesh("North boundary", this.assets.box, this.assets.boundary, this.assets.root,
      new vec3(0, 1.5, -edge), new vec3(length, 3, 3))
    this.mesh("South boundary", this.assets.box, this.assets.boundary, this.assets.root,
      new vec3(0, 1.5, edge), new vec3(length, 3, 3))
    this.mesh("West boundary", this.assets.box, this.assets.boundary, this.assets.root,
      new vec3(-edge, 1.5, 0), new vec3(3, 3, length))
    this.mesh("East boundary", this.assets.box, this.assets.boundary, this.assets.root,
      new vec3(edge, 1.5, 0), new vec3(3, 3, length))

    for (let id = 0; id < 4; id++) {
      const root = global.scene.createSceneObject(`Player ${id}`)
      root.setParent(this.assets.root)
      const head = this.mesh("Head", this.assets.sphere, this.assets.trails[id], root,
        new vec3(0, 24, 0), new vec3(11, 11, 11))
      const ring = this.mesh("Ring", this.assets.torus, this.assets.trails[id], root,
        new vec3(0, 24, 0), new vec3(15, 15, 15))
      ring.object.getTransform().setLocalRotation(quat.fromEulerAngles(Math.PI / 2, 0, 0))
      this.mesh("Stem", this.assets.cylinder, this.assets.claims[id], root,
        new vec3(0, 11, 0), new vec3(3, 18, 3))
      this.mesh("Visor", this.assets.box, this.assets.white, root,
        new vec3(0, 25, -6), new vec3(5, 2.5, 1.5))
      this.markers[id] = {root, head: head.object, ring: ring.object, target: new vec3(0, 0, 0)}
    }
    this.createGuide()
  }

  private createGrid(): void {
    const batch = this.createBatch("Static grid", this.assets.grid)
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        addBox(batch.vertices, batch.indices, this.position(x, y, 0),
          new vec3(CELL_SIZE * 0.93, 0.8, CELL_SIZE * 0.93))
      }
    }
    this.updateBatch(batch)
  }

  private createBatch(name: string, material: Material): BatchedVisual {
    const object = global.scene.createSceneObject(name)
    object.setParent(this.assets.root)
    const visual = object.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    visual.mainMaterial = material
    const builder = makeBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3, normalized: true},
      {name: "texture0", components: 2},
    ])
    object.enabled = false
    return {builder, visual, object, vertices: [], indices: []}
  }

  private updateBatch(batch: BatchedVisual): void {
    if (batch.vertices.length === 0) {
      batch.object.enabled = false
      return
    }
    const vertexCount = batch.builder.getVerticesCount()
    const indexCount = batch.builder.getIndicesCount()
    if (vertexCount > 0) batch.builder.eraseVertices(0, vertexCount)
    if (indexCount > 0) batch.builder.eraseIndices(0, indexCount)
    batch.builder.appendVerticesInterleaved(batch.vertices)
    batch.builder.appendIndices(batch.indices)
    batch.builder.updateMesh()
    batch.visual.mesh = batch.builder.getMesh()
    batch.object.enabled = true
    batch.vertices = []
    batch.indices = []
  }

  private mesh(
    name: string,
    mesh: RenderMesh,
    material: Material,
    parent: SceneObject,
    position: vec3,
    scale: vec3,
  ): MeshView {
    const object = global.scene.createSceneObject(name)
    object.setParent(parent)
    const visual = object.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    visual.mesh = mesh
    visual.mainMaterial = material
    object.getTransform().setLocalPosition(position)
    object.getTransform().setLocalScale(scale)
    return {object, visual}
  }

  private position(x: number, y: number, height: number): vec3 {
    return new vec3((x - 5) * CELL_SIZE, height, (y - 5) * CELL_SIZE)
  }

  private createGuide(): void {
    const path: {x: number; y: number}[] = []
    for (let dx = -2; dx <= 2; dx++) path.push({x: dx, y: -2})
    for (let dy = -1; dy <= 2; dy++) path.push({x: 2, y: dy})
    for (let dx = 1; dx >= -2; dx--) path.push({x: dx, y: 2})
    for (let dy = 1; dy >= -1; dy--) path.push({x: -2, y: dy})
    for (const offset of path) {
      const dot = this.mesh("First loop guide", this.assets.torus, this.assets.trails[0], this.assets.root,
        this.position(5 + offset.x, 5 + offset.y, 3), new vec3(8, 8, 8))
      dot.object.getTransform().setLocalRotation(quat.fromEulerAngles(Math.PI / 2, 0, 0))
      this.guideDots.push(dot.object)
    }
  }

  setGuideActive(active: boolean): void {
    this.guideActive = active
  }

  sync(game: TrailboundGame): void {
    const dirtyPlayers = [false, false, false, false]
    for (let i = 0; i < game.claims.length; i++) {
      const claimOwner = game.claims[i]
      const trailOwner = game.trails[i]
      if (claimOwner !== this.lastClaims[i]) {
        if (this.lastClaims[i] >= 0) dirtyPlayers[this.lastClaims[i]] = true
        if (claimOwner >= 0) dirtyPlayers[claimOwner] = true
        this.lastClaims[i] = claimOwner
      }
      if (trailOwner !== this.lastTrails[i]) {
        if (this.lastTrails[i] >= 0) dirtyPlayers[this.lastTrails[i]] = true
        if (trailOwner >= 0) dirtyPlayers[trailOwner] = true
        this.lastTrails[i] = trailOwner
      }
      const x = i % 11
      const y = Math.floor(i / 11)
      if (claimOwner >= 0) {
        addBox(this.claimBase[claimOwner].vertices, this.claimBase[claimOwner].indices,
          this.position(x, y, 2.5), new vec3(CELL_SIZE * 0.86, 4, CELL_SIZE * 0.86))
        addBox(this.claimCap[claimOwner].vertices, this.claimCap[claimOwner].indices,
          this.position(x, y, 5), new vec3(CELL_SIZE * 0.64, 1.2, CELL_SIZE * 0.64))
      }
      if (trailOwner >= 0) {
        addBox(this.trailPylon[trailOwner].vertices, this.trailPylon[trailOwner].indices,
          this.position(x, y, 11), new vec3(3, 18, 3))
        addOctahedron(this.trailOrb[trailOwner].vertices, this.trailOrb[trailOwner].indices,
          this.position(x, y, 23), 4)
      }
    }
    for (let id = 0; id < 4; id++) {
      if (!dirtyPlayers[id]) {
        // Arrays accumulate across syncs until that player's mesh changes.
        continue
      }
      this.updateBatch(this.claimBase[id])
      this.updateBatch(this.claimCap[id])
      this.updateBatch(this.trailPylon[id])
      this.updateBatch(this.trailOrb[id])
    }
  }

  burst(game: TrailboundGame, playerId: number, count = 10): void {
    const player = game.players[playerId]
    const center = this.position(player.pos.x, player.pos.y, 20)
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2 + Math.random() * 0.35
      const speed = 35 + Math.random() * 45
      const particle = this.mesh("Capture particle", this.assets.sphere, this.assets.trails[playerId], this.assets.root,
        center, new vec3(4, 4, 4))
      this.particles.push({
        object: particle.object,
        velocity: new vec3(Math.cos(angle) * speed, 35 + Math.random() * 35, Math.sin(angle) * speed),
        life: 0.85,
        maxLife: 0.85,
      })
    }
  }

  update(dt: number, game: TrailboundGame): void {
    this.elapsed += dt
    for (let id = 0; id < this.markers.length; id++) {
      const marker = this.markers[id]
      const player = game.players[id]
      marker.root.enabled = player.alive
      if (!player.alive) continue
      marker.target = this.position(player.pos.x, player.pos.y, 0)
      const transform = marker.root.getTransform()
      const current = transform.getLocalPosition()
      const blend = Math.min(1, dt * 12)
      transform.setLocalPosition(new vec3(
        current.x + (marker.target.x - current.x) * blend,
        0,
        current.z + (marker.target.z - current.z) * blend,
      ))
      const dx = marker.target.x - current.x
      const dz = marker.target.z - current.z
      if (Math.abs(dx) + Math.abs(dz) > 0.5) {
        transform.setLocalRotation(quat.fromEulerAngles(0, Math.atan2(dx, dz), 0))
      }
      const bob = Math.sin(this.elapsed * 4 + id) * 1.5
      marker.head.getTransform().setLocalPosition(new vec3(0, 24 + bob, 0))
      marker.ring.getTransform().setLocalPosition(new vec3(0, 24 + bob, 0))
      marker.ring.getTransform().setLocalRotation(quat.fromEulerAngles(Math.PI / 2, 0, this.elapsed * 0.7 + id))
    }

    for (let i = 0; i < this.guideDots.length; i++) {
      const dot = this.guideDots[i]
      dot.enabled = this.guideActive
      const pulse = 7 + 2 * (0.5 + 0.5 * Math.sin(this.elapsed * 6 - i * 0.55))
      dot.getTransform().setLocalScale(new vec3(pulse, pulse, pulse))
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]
      particle.life -= dt
      if (particle.life <= 0) {
        particle.object.destroy()
        this.particles.splice(i, 1)
        continue
      }
      const transform = particle.object.getTransform()
      const position = transform.getLocalPosition()
      particle.velocity.y -= 90 * dt
      transform.setLocalPosition(new vec3(
        position.x + particle.velocity.x * dt,
        position.y + particle.velocity.y * dt,
        position.z + particle.velocity.z * dt,
      ))
      const scale = 4 * Math.max(0.05, particle.life / particle.maxLife)
      transform.setLocalScale(new vec3(scale, scale, scale))
    }
  }
}
