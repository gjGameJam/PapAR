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
    private gridArray = new Array(this.height * this.height).fill(0).map(() => vec2.zero()); // OR: new vec2(0, 0)
    private gridData = StorageProperty.manualVec2Array("serverGrid", this.gridArray);
    private gridReady = false; //flag for grid being ready to use
    
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
        //print(this.gridArray[0] === this.gridArray[1]); // Should be false if they're independent
        this.gridData.setPendingValue(this.gridArray);
        this.gridReady = true;
    }
    
    //to update the shared storage property given a player's location
    receivePlayerData(ID: number, xpos: number, ypos: number, zpos: number){
        //return early if grid is not ready        
        if (!this.gridReady){
            return;
        }
        //calculate the array index based on x and y
        let idx = this.height * ypos + xpos;
        //check if index is OOB
        if (idx < 0 || idx >= this.gridData.currentValue.length) {
            print(`Invalid grid index: ${idx} for x=${xpos}, y=${ypos}`);
            return;
        }
        //the vector2 state represents the claim and stake status (in order) of the cell
        let cellVec = this.gridData.currentValue[idx];
        //get owner and staker of grid cell
        let claimOwner = cellVec.x;
        let stakeOwner = cellVec.y;
        
        
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
