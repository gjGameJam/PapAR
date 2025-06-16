import {SessionController} from '../SpectaclesSyncKit/Core/SessionController';
import {StorageProperty} from "SpectaclesSyncKit/Core/StorageProperty"
import {SyncEntity} from "SpectaclesSyncKit/Core/SyncEntity"
import {SyncKitLogger} from "SpectaclesSyncKit/Utils/SyncKitLogger"

@component
export class Networker extends BaseScriptComponent {
    //connection id
    clientID: number;
    gridSyncEntity: SyncEntity;
    
    private height = 40; //the length and width of the grid cube
    //vector 2 array of <0,0> with unique, unrelated elemenets
    private gridArray = new Array(this.height * this.height).fill(null).map(() => vec2.zero()); // OR: new vec2(0, 0)
    private gridData = StorageProperty.manualVec2Array("turnsCount", this.gridArray);
    
    //script to manager the grid claim modification permissions
    onAwake() {
        //listen for session controller
        SessionController.getInstance().notifyOnReady(() => {
            // SessionController is ready to use
            print('session controller notify on ready for networker');
            //create sync entity of vector2 array <claimID, stakeID> type for grid data
            this.gridSyncEntity = new SyncEntity(
                this, //first param (this) is self ref
                null, //second param is storagePropertySet (will be grid)
                false, //third param is claimOwnership (false so anyone can modify grid)
                "Session", //fourth param is persistence (session so grid always exists indepedent of players)
                null //fifth param is networkIDOptions
            );
            //add storage properties for grid data
            this.gridSyncEntity.addStorageProperty(this.gridData);
            // Limit the grid to only send updates out 10 times per second
            this.gridData.sendsPerSecondLimit = 10;
            //when unowned sync entity for grid storage is ready, start game
            this.gridSyncEntity.notifyOnReady(() => this.onReady());
            
        });
        
    }
    
    //called when grid sync entity and session controller are ready
    onReady() {
        print('The session has started and grid entity is ready!')
        // vector 2 array (grid representation) is now ready
        
    }
    
    //to update the shared storage property given a player's location
    receivePlayerData(ID: number, xpos: number, ypos: number, zpos: number){
        //calculate the array index based on x and y
        let idx = this.height * ypos + xpos;
        //the vector2 state represents the claim and stake status (in order) of the cell
//        let cellVec = this.gridData.currentValue[idx];
//        //get owner and staker of grid cell
//        let claimOwner = cellVec.x;
//        let stakeOwner = cellVec.y;
        
        
        //if not staked, stake
        
        //if staked, owner of stake dies (even if self)
        
        //if claimed:
        //      by self: check if stake loop exists and add to claim
        //      by other: update stake data in cell without updating claim
    }
    
    //setter for player id (hashed display name from session controller)
    setPlayerID(ID: number){
        this.clientID = ID;
    }
    
    

    //this is the userId of the client with this script
    //sessionController.getLocalUserId()
    
    //meet with spectacles team to:
    //1: improve/refine understand on below plan 
    //2: get multiple previews of same session emulating multiplayer
    
    //grid networking plan:
    //TODO: use CreateRealtimeStore to store grid as general data store in multiplayer session
    //    have owner if needed (doesn't seem to be with ownership.unowned) with realtime store 
    //    and send grid updates to grid claimer to use real time store grid
    //TODO: update player visuals minimap to use grid's real time store updates
    
    
    
}
