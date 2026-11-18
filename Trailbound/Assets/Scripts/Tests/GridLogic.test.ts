import assert from "node:assert/strict"
import {
  RESPAWN_SECONDS,
  TrailboundGame,
  indexOf,
// @ts-expect-error Node 25 runs this test file directly with native type stripping.
} from "../Core/GridLogic.ts"

function closeHumanLoop(game: TrailboundGame): void {
  const path = [
    [5, 4], [5, 3], [6, 3], [7, 3], [7, 4], [7, 5],
    [7, 6], [7, 7], [6, 7], [5, 7], [5, 6],
  ]
  for (const [x, y] of path) game.movePlayer(0, x, y)
}

const tests: {name: string; run: () => void}[] = []
function test(name: string, run: () => void): void {
  tests.push({name, run})
}

test("reset creates four separate five-cell homes", () => {
  const game = new TrailboundGame()
  for (let id = 0; id < 4; id++) {
    assert.equal(game.claimsCount(id), 5)
    assert.equal(game.players[id].alive, true)
  }
})

test("relocateHome moves a player's home to their cell without touching rivals", () => {
  const game = new TrailboundGame()
  const rivalClaims = [1, 2, 3].map((id) => game.claimsCount(id))
  const target = game.relocateHome(2, {x: 5, y: 9})
  assert.equal(JSON.stringify(target), JSON.stringify({x: 5, y: 9}))
  assert.equal(game.claimsCount(2), 5)
  assert.equal(game.claims[indexOf(5, 9, game.size)], 2)
  assert.equal(game.claims[indexOf(game.size - 3, game.size - 3, game.size)], -1)
  assert.equal(JSON.stringify(game.players[2].pos), JSON.stringify(target))
  assert.equal(game.claimsCount(1), rivalClaims[0])
  assert.equal(game.claimsCount(3), rivalClaims[2])
})

test("relocateHome clamps edge cells and avoids occupied ground", () => {
  const game = new TrailboundGame()
  const edge = game.relocateHome(0, {x: 0, y: 10})
  assert.equal(JSON.stringify(edge), JSON.stringify({x: 1, y: game.size - 2}))
  const taken = game.relocateHome(0, game.players[1].spawn)
  assert.equal(JSON.stringify(taken) === JSON.stringify(game.players[1].spawn), false)
  assert.equal(game.claimsCount(1), 5)
  assert.equal(game.claimsCount(0) >= 1, true)
  assert.equal(game.claims[indexOf(taken.x, taken.y, game.size)], 0)
})

test("remote slots are never moved or respawned by this device", () => {
  const game = new TrailboundGame()
  game.killPlayer(1, 0, "cut")
  const remote = [false, true, false, false]
  for (let i = 0; i < 100; i++) game.update(0.1, false, {x: 5, y: 9}, [false, false, true, true], remote)
  assert.equal(game.players[1].alive, false)
  assert.equal(game.claimsCount(1), 0)
})

test("a closed walk converts its trail and fills enclosed cells", () => {
  const game = new TrailboundGame()
  closeHumanLoop(game)
  const capture = game.drainEvents().find((event) => event.type === "capture" && event.player === 0)
  assert(capture && capture.type === "capture")
  assert(capture.enclosed > 0)
  assert.equal(game.players[0].trail.length, 0)
  for (const [x, y] of [[6, 4], [6, 5], [6, 6]]) {
    assert.equal(game.claims[indexOf(x, y, game.size)], 0)
  }
  assert(game.score(0) > 50)
})

test("backtracking over an exposed own trail kills and cleans up", () => {
  const game = new TrailboundGame()
  game.movePlayer(0, 5, 4)
  game.movePlayer(0, 5, 3)
  game.movePlayer(0, 6, 3)
  game.movePlayer(0, 5, 3)
  assert.equal(game.players[0].alive, false)
  assert.equal(game.claimsCount(0), 0)
  assert.equal(game.trails.includes(0), false)
  assert(game.drainEvents().some((event) => event.type === "death" && event.cause === "self"))
})

test("cutting a bot trail kills its owner and awards the cutter", () => {
  const game = new TrailboundGame()
  game.movePlayer(1, 8, 3)
  game.movePlayer(1, 7, 3)
  assert.equal(game.trails[indexOf(7, 3, game.size)], 1)
  game.movePlayer(0, 7, 3)
  assert.equal(game.players[1].alive, false)
  assert.equal(game.players[0].kills, 1)
  assert.equal(game.players[0].alive, true)
  game.update(RESPAWN_SECONDS + 0.1)
  assert.equal(game.players[1].alive, true)
  assert.equal(game.players[1].trail.length, 0)
})

test("out-of-bounds movement kills without writing invalid cells", () => {
  const game = new TrailboundGame()
  game.movePlayer(0, -1, 5)
  assert.equal(game.players[0].alive, false)
  assert.equal(game.claimsCount(0), 0)
  assert(game.drainEvents().some((event) => event.type === "death" && event.cause === "bounds"))
})

test("respawn chooses an open cell and restores a home", () => {
  const game = new TrailboundGame()
  game.killPlayer(1, 0, "cut")
  game.respawn(1, game.players[1].spawn)
  assert.equal(game.players[1].alive, true)
  assert(game.claimsCount(1) > 0)
  assert.equal(game.trails.includes(1), false)
})

test("deterministic full-round bot simulation stays valid and produces gameplay", () => {
  const game = new TrailboundGame(11, 123456)
  let captures = 0
  let deaths = 0
  for (let tick = 0; tick < 360; tick++) {
    game.update(0.25, true)
    for (const event of game.drainEvents()) {
      if (event.type === "capture") captures++
      if (event.type === "death") deaths++
    }
    for (let i = 0; i < game.claims.length; i++) {
      assert(game.claims[i] >= -1 && game.claims[i] < 4)
      assert(game.trails[i] >= -1 && game.trails[i] < 4)
    }
  }
  assert(captures >= 4)
  assert(game.leaderboard().some((entry) => entry.score > 0))
  console.log(`Simulation: ${captures} captures, ${deaths} deaths, scores ${game.leaderboard().map((entry) => `${entry.name}:${entry.score}`).join(" ")}`)
})

let failures = 0
for (const {name, run} of tests) {
  try {
    run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${name}`, error)
  }
}
if (failures > 0) throw new Error(`${failures} test(s) failed`)
console.log(`${tests.length} tests passed`)
