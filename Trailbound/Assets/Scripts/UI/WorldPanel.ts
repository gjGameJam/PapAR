import {Button} from "UIKit.lspkg/Scripts/Components/Button/Button"
import {ElementContent} from "UIKit.lspkg/Scripts/Components/Content/ElementContent"
import {addContentToElement} from "UIKit.lspkg/Scripts/Components/Content/ElementContentFactory"
import {FlexLayout} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout"
import {FlexItem} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem"
import {
  FlexAlign,
  FlexDirection,
  FlexJustify,
} from "UIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes"
import {createChildSceneObjectWithParentLayer} from "UIKit.lspkg/Scripts/Utility/SceneUtilities"
import {Frame} from "UIKit.lspkg/Scripts/Components/Frame/Frame"
import {ThemeService} from "UIKit.lspkg/Scripts/Themes/ThemeService"
import {System3} from "UIKit.lspkg/Scripts/Themes/System-3.0/System3"
import type {LeaderboardEntry} from "../Core/GridLogic"

const CYAN = new vec4(0.2, 0.95, 1, 1)
const PLAYER_COLORS = [
  CYAN,
  new vec4(1, 0.3, 0.68, 1),
  new vec4(1, 0.72, 0.24, 1),
  new vec4(0.55, 1, 0.38, 1),
]

type PageMode = "menu" | "hud"

// Panel sizes in cm. At the tag-along distances below these subtend roughly
// 17-19 degrees: large enough to read and pinch comfortably, small enough to
// stay out of the way of the arena.
const MENU_SIZE = new vec2(30, 28)
const HUD_SIZE = new vec2(30, 22)
const MENU_DISTANCE = 90
const HUD_DISTANCE = 110
const BUTTON_SIZE = new vec3(16, 5, 1)

@component
export class WorldPanel extends BaseScriptComponent {
  onStartRequested: (() => void) | null = null
  onJoinRequested: (() => void) | null = null

  private built = false
  private mode: PageMode = "menu"
  private menuPage: SceneObject | null = null
  private hudPage: SceneObject | null = null
  private menuTitle: ElementContent | null = null
  private menuBody: ElementContent | null = null
  private menuVersion: ElementContent | null = null
  private startButton: Button | null = null
  private startButtonContent: ElementContent | null = null
  private joinButton: Button | null = null
  private timerText: ElementContent | null = null
  private statusText: ElementContent | null = null
  private scoreTexts: ElementContent[] = []

  private pendingTitle = "TRAILBOUND"
  private pendingBody = ""
  private pendingButton = "START"
  private pendingStatus = "LEAVE HOME  ·  LOOP  ·  RETURN"
  private pendingTimer = "1:30"
  private pendingScores = [50, 50, 50, 50]

  private frame: Frame | null = null

  onAwake(): void {
    ThemeService.getInstance().setTheme(System3)
    const frame = this.sceneObject.createComponent(Frame.getTypeName()) as Frame
    frame.innerSize = MENU_SIZE
    frame.padding = new vec2(2, 2)
    frame.useTagAlong = true
    frame.tagAlongDistance = MENU_DISTANCE
    frame.hasShadow = true
    this.frame = frame
    frame.onInitialized.add(() => this.buildContent())
  }

  private item(object: SceneObject, height: number): FlexItem {
    const item = object.createComponent(FlexItem.getTypeName()) as FlexItem
    item.overrideHeight = height
    item.flexShrink = 0
    return item
  }

  private label(
    parent: SceneObject,
    name: string,
    text: string,
    textSize: number,
    box: vec2,
    color: vec4 | null = null,
  ): {object: SceneObject; content: ElementContent} {
    const object = createChildSceneObjectWithParentLayer(name, parent)
    const content = addContentToElement(object, {text, textSize})
    content.sizeOverride = box
    if (color) {
      content.useTextColorOverride = true
      content.textColorOverride = color
    }
    return {object, content}
  }

  private column(object: SceneObject, width: number, height: number): FlexLayout {
    const column = object.createComponent(FlexLayout.getTypeName()) as FlexLayout
    column.direction = FlexDirection.Column
    column.width = width
    column.height = height
    column.justifyContent = FlexJustify.Start
    column.alignItems = FlexAlign.Stretch
    column.rowGap = 1
    return column
  }

  private buildContent(): void {
    if (this.built) return
    this.built = true

    const contentRoot = createChildSceneObjectWithParentLayer("Panel Content", this.frame.content)
    contentRoot.getTransform().setLocalPosition(new vec3(0, 0, 0.3))

    this.menuPage = createChildSceneObjectWithParentLayer("Menu Page", contentRoot)
    const menuLayout = this.column(this.menuPage, 30, 28)

    const title = this.label(this.menuPage, "Title", this.pendingTitle, 88, new vec2(30, 4))
    this.menuTitle = title.content
    this.item(title.object, 4)

    const body = this.label(this.menuPage, "Body", this.pendingBody, 42, new vec2(30, 11))
    this.menuBody = body.content
    const bodyItem = this.item(body.object, 11)
    bodyItem.flexGrow = 1

    const buttonObject = createChildSceneObjectWithParentLayer("Start Button", this.menuPage)
    this.startButton = buttonObject.createComponent(Button.getTypeName()) as Button
    this.startButton.setVariant({theme: "System3", shape: "Rectangle", style: "Primary"})
    this.startButton.size = BUTTON_SIZE
    this.startButton.initialize()
    this.startButtonContent = addContentToElement(buttonObject, {text: this.pendingButton, textSize: 42})
    this.startButtonContent.useTextColorOverride = true
    this.startButtonContent.textColorOverride = new vec4(0.015, 0.03, 0.05, 1)
    this.startButton.onTriggerUp.add(() => {
      this.onStartRequested?.()
    })
    this.item(buttonObject, 5)

    const joinObject = createChildSceneObjectWithParentLayer("Join Button", this.menuPage)
    this.joinButton = joinObject.createComponent(Button.getTypeName()) as Button
    this.joinButton.setVariant({theme: "System3", shape: "Rectangle", style: "Secondary"})
    this.joinButton.size = BUTTON_SIZE
    this.joinButton.initialize()
    const joinContent = addContentToElement(joinObject, {text: "JOIN SESSION", textSize: 34})
    joinContent.useTextColorOverride = true
    joinContent.textColorOverride = new vec4(0.015, 0.03, 0.05, 1)
    this.joinButton.onTriggerUp.add(() => {
      this.onJoinRequested?.()
    })
    this.item(joinObject, 5)

    const version = this.label(this.menuPage, "Version", "v1.0.0", 24, new vec2(30, 2))
    this.menuVersion = version.content
    this.item(version.object, 2)
    menuLayout.refreshChildren()

    this.hudPage = createChildSceneObjectWithParentLayer("HUD Page", contentRoot)
    const hudLayout = this.column(this.hudPage, 30, 22)

    const header = createChildSceneObjectWithParentLayer("Header", this.hudPage)
    this.item(header, 4)
    const headerRow = header.createComponent(FlexLayout.getTypeName()) as FlexLayout
    headerRow.direction = FlexDirection.Row
    headerRow.width = 30
    headerRow.height = 4
    headerRow.justifyContent = FlexJustify.SpaceBetween
    headerRow.alignItems = FlexAlign.Center

    const hudTitle = this.label(header, "HUD Title", "TRAILBOUND", 44, new vec2(18, 4))
    this.item(hudTitle.object, 4)
    const timer = this.label(header, "Timer", this.pendingTimer, 52, new vec2(10, 4))
    this.timerText = timer.content
    this.item(timer.object, 4)
    headerRow.refreshChildren()

    for (let id = 0; id < 4; id++) {
      const row = this.label(this.hudPage, `Score ${id}`, "", 44, new vec2(30, 3), PLAYER_COLORS[id])
      this.scoreTexts[id] = row.content
      this.item(row.object, 3)
    }

    const status = this.label(this.hudPage, "Status", this.pendingStatus, 38, new vec2(30, 4))
    this.statusText = status.content
    this.item(status.object, 4)
    hudLayout.refreshChildren()

    this.applyPending()
    this.setMode(this.mode)
  }

  private setMode(mode: PageMode): void {
    this.mode = mode
    if (this.menuPage) this.menuPage.enabled = mode === "menu"
    if (this.hudPage) this.hudPage.enabled = mode === "hud"
    if (this.frame?.initialized) {
      this.frame.innerSize = mode === "menu" ? MENU_SIZE : HUD_SIZE
      this.frame.tagAlongDistance = mode === "menu" ? MENU_DISTANCE : HUD_DISTANCE
    }
  }

  private applyPending(localPlayerId = 0): void {
    if (this.menuTitle) this.menuTitle.text = this.pendingTitle
    if (this.menuBody) this.menuBody.text = this.pendingBody
    if (this.startButtonContent) this.startButtonContent.text = this.pendingButton
    if (this.timerText) this.timerText.text = this.pendingTimer
    if (this.statusText) this.statusText.text = this.pendingStatus
    for (let id = 0; id < this.scoreTexts.length; id++) {
      if (this.scoreTexts[id]) this.scoreTexts[id].text = `${id === localPlayerId ? "YOU" : ["P1", "VEX", "NOVA", "MOSS"][id]}  ${this.pendingScores[id]}`
    }
  }

  showWelcome(): void {
    this.pendingTitle = "TRAILBOUND"
    this.pendingBody = "Walk out of your cyan home to draw a trail.\n" +
      "Return home to fill the loop.\n" +
      "Cut rival trails. Don't cross your own.\n\n" +
      "SAFETY FIRST\n" +
      "Clear a 3 × 3 m space.\n" +
      "Walk—never run. Watch for obstacles.\n\n" +
      "Version 1.0.0"
    this.pendingButton = "START"
    this.applyPending()
    this.setMode("menu")
  }

  showCountdown(seconds: number): void {
    this.pendingTitle = "GET READY"
    this.pendingBody = `Your cyan home is at your feet.\nLeave it, loop around, and come back.\n\n${Math.max(1, Math.ceil(seconds))}`
    this.pendingButton = "..."
    this.applyPending()
    this.setMode("menu")
  }

  showResults(leaders: LeaderboardEntry[]): void {
    const winner = leaders[0]
    this.pendingTitle = winner.id === 0 ? "YOU WIN!" : `${winner.name} WINS`
    this.pendingBody = leaders.map((entry, index) =>
      `${index + 1}. ${entry.name}  ${entry.score} pts  ·  ${entry.claims} cells  ·  ${entry.kills} cuts`
    ).join("\n")
    this.pendingButton = "REPLAY"
    this.applyPending()
    this.setMode("menu")
  }

  showHud(): void {
    this.setMode("hud")
  }

  updateHud(timer: string, scores: number[], status: string, localPlayerId = 0): void {
    this.pendingTimer = timer
    this.pendingScores = [...scores]
    this.pendingStatus = status
    this.applyPending(localPlayerId)
  }
}
