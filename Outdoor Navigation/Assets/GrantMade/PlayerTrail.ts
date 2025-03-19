import { PlayerTracker } from "./PlayerTracker";

@component
export class PlayerClaims extends BaseScriptComponent {
    
    playerCoords: PlayerTracker;

    onAwake() {
        print("PlayerClaims awake");

        // Get the PlayerTracker component attached to the same scene object
//        this.playerCoords = this.getSceneObject().getComponent(PlayerTracker) as PlayerTracker;  // Cast to PlayerTracker
//
//        if (this.playerCoords) {
//            let homePoint = this.playerCoords.getHomePoint();
//            //print("Home Point:", homePoint.latitude, homePoint.longitude);
//        } else {
//            print("PlayerTracker component not found!");
//        }
    }
}
