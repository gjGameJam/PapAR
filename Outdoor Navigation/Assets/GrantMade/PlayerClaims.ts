import { PlayerTracker } from "./PlayerTracker";

@component
export class PlayerClaims extends BaseScriptComponent {
    
    @input 
    playerCoords: PlayerTracker; //player coords and color data
    
    claimColor: vec4; //the color of this player's claim'
    
 //1   private claimUpdate: DelayedCallbackEvent;

    onAwake() {
        this.claimColor = this.playerCoords.getPlayerColor(1); //guve id number 1 //TODO create id system
//2        this.createEvent('OnStartEvent').bind(() => {
//          this.startAllCallbacks();
//        });
        
//        // Create and bind event to repeatedly run
//        this.claimUpdate = this.createEvent('DelayedCallbackEvent');
//        this.claimUpdate.bind(() => {
//            
//          print("Claim");
//          this.claimUpdate.reset(1.0);
//        });
        

    }
    
    //function called on start that begins all callbacks
//3    startAllCallbacks(){
//        //repeat claim update
//        this.claimUpdate.reset(0);
//    }
    
    //called by player coords to create spawn point of player (first coord reading)
    createHomeClaim(lat: number, long: Number){
        print("Home Claim Origin:" +  lat + long);
        //TODO: spawn home chunk of land around current pos
    }
    
    //called by player coords when player coordinates change
    createNewStake(lat: number, long: Number){
        print("stake coords:" +  lat + long);
        //TODO: spawn trail of stakes
        //check if in or outside of claimed territory   
        if (this.checkIfInTerritory()){
          //if back inside, check if staking path exists and create/add new domain to current claim
          this.claimStakedLand();
        }
        else if (this.playerCoords.hasPrevAndCurrCoords()) { //if valid path, create stake trail
          //TODO: create stake at location and connect with previous stake
          //if staking path loops back into itself before reaching claimed territory, you die      
          this.checkForStakeLoop();
        }
    }
    
    //function to check if player is in their own claimed territory
    checkIfInTerritory(){
          return true;
    }
      
    //function that is called while touching home territory
    //if stakes exist, add associated new area to claim
    claimStakedLand(){
          //do nothing if there is no staked land
    }
        
    checkForStakeLoop(){
           
    }
    
    
    
}
