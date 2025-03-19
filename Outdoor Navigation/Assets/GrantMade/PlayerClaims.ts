import { PlayerTracker } from "./PlayerTracker";

@component
export class PlayerClaims extends BaseScriptComponent {
    
    @input 
    playerCoords: PlayerTracker; //player coords and color data
    
    claimColor: vec4; //the color of this player's claim'

    onAwake() {
        
        this.createEvent('OnStartEvent').bind(() => {
          this.startAllCallbacks();
        });
        

    }
    
    //function called on start that begins all callbacks
    startAllCallbacks(){
        //print("PlayerClaims awake");
    }
    
    createHomeClaim(lat: number, long: Number){
        print("Home Claim Origin:" +  lat + long);
        //TODO: spawn home chunk of land around current pos
    }
}
