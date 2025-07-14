import {SessionController} from '../SpectaclesSyncKit/Core/SessionController';
import {StorageProperty} from "SpectaclesSyncKit/Core/StorageProperty"
import {SyncEntity} from "SpectaclesSyncKit/Core/SyncEntity"
import {SyncKitLogger} from "SpectaclesSyncKit/Utils/SyncKitLogger"

@component
export class Networker extends BaseScriptComponent {
    //to help debug
    showLogs: boolean = true;
    //connection id
    clientID: number;
    gridSyncEntity: SyncEntity;
    
    // Initialize the array of data (all zeroes on start)
    private gridArray: vec2[] = []
    
    // Create a storage property for the gridSyncEntity
    private gridData: StorageProperty<vec2[]>
    
    private height = 40; //the length and width of the grid cube
    //vector 2 array of <0,0> with unique, unrelated elemenets
    //private gridArray = new Array(this.height * this.height).fill(0).map(() => vec2.zero()); // OR: new vec2(0, 0)
    //private gridData = StorageProperty.manualVec2Array("serverGrid", this.gridArray);
    private gridReady = false; //flag for grid being ready to use
    
    //script to manager the grid claim modification permissions
    onAwake() {
        // Initialize the grid array properly
        this.gridArray = []
        for (let i = 0; i < this.height * this.height; i++) {
            this.gridArray.push(vec2.zero());//make sure it starts with all zeros
        }
        //check grid array data
        if (this.showLogs) {
            print("NetworkerTS: Grid array initialized with length: " + this.gridArray.length);
            print("NetworkerTS: First element: " + this.gridArray[0]);
            print("NetworkerTS: Elements are independent: " + (this.gridArray[0] !== this.gridArray[1]));
        }
        
        // Create the storage property after array initialization
        this.gridData = StorageProperty.manualVec2Array("serverGrid", this.gridArray);
        //print out that storage property was created
        if (this.showLogs) {
            print("NetworkerTS: Storage property created");
        }
        
        // Create new sync entity for this script (exactly like ControllerTS)
        this.gridSyncEntity = new SyncEntity(this);
        
        if (this.showLogs) {
            print("NetworkerTS: Sync entity created")
        }
        
        // Add storage properties for grid data
        this.gridSyncEntity.addStorageProperty(this.gridData);
        //print out storage property was added successfully
        if (this.showLogs) {
            print("NetworkerTS: Storage property added to sync entity")
        }
        
        // Limit the grid to only send updates out 10 times per second
        this.gridData.sendsPerSecondLimit = 10
        
        // Add change listener to debug storage property updates
        this.gridData.onAnyChange.add((newVal: vec2[], oldVal: vec2[]) => {
            if (this.showLogs) {
                print("NetworkerTS: Grid data changed!")
                print("NetworkerTS: New value length: " + (newVal ? newVal.length : "undefined"))
                print("NetworkerTS: Old value length: " + (oldVal ? oldVal.length : "undefined"))
            }
        })
        //print out that onAnyChange has a function
        if (this.showLogs) {
            print("NetworkerTS: Change listener added")
        }
        
        // Set up the sync entity notify on ready callback (exactly like ControllerTS)
        // Note: Only update the sync entity once it is ready
        this.gridSyncEntity.notifyOnReady(() => this.onReady())
        
    }
    
    //called when grid sync entity and session controller are ready
    onReady() {
        if (this.showLogs) {
            print("NetworkerTS: onReady called")
        }
        
        // Debug the storage property state
        print("NetworkerTS: Grid array length: " + this.gridArray.length)
        print("NetworkerTS: Grid data current value: " + this.gridData.currentValue)
        print("NetworkerTS: Grid data current value length: " + (this.gridData.currentValue ? this.gridData.currentValue.length : "undefined"))
        print("NetworkerTS: Grid data currentOrPendingValue: " + this.gridData.currentOrPendingValue)
        print("NetworkerTS: Grid data currentOrPendingValue length: " + (this.gridData.currentOrPendingValue ? this.gridData.currentOrPendingValue.length : "undefined"))
        
        // Make sure all cells are independent (this prints false, which is the desired outcome)
        print("NetworkerTS: Elements are independent: " + (this.gridArray[0] === this.gridArray[1])) // Should be false if they're independent
        
        // Set the pending value here
        this.gridData.setPendingValue(this.gridArray)
        
        // Set ready flag so grid can be used
        this.gridReady = true
        
        if (this.showLogs) {
            print("NetworkerTS: Grid is ready!")
        }
    }
    
//    //to update the shared storage property given a player's location
//    receivePlayerData(ID: number, xpos: number, ypos: number, zpos: number){
//        //return early if grid is not ready        
//        if (!this.gridReady){
//            return;
//        }
//        //calculate the array index based on x and y
//        let idx = this.height * ypos + xpos;
//        //check if index is OOB
//        if (idx < 0 || idx >= this.gridData.currentValue.length) {
//            print(`Invalid grid index: ${idx} for x=${xpos}, y=${ypos}`);
//            return;
//        }
//        //the vector2 state represents the claim and stake status (in order) of the cell
//        let cellVec = this.gridData.currentValue[idx];
//        //get owner and staker of grid cell
//        let claimOwner = cellVec.x;
//        let stakeOwner = cellVec.y;
//    }
    
    //setter for player id (hashed display name from session controller)
    setPlayerID(ID: number){
        this.clientID = ID;
    }
    
    

    //this is the userId of the client with this script
    //sessionController.getLocalUserId()
    
    //meet with spectacles team to:
    //1: get multiple previews of same session emulating multiplayer
    
    //function to update a grid position (grid cell is vec2 representing claim and stake owner(s))
    sendData(ID: number, xpos: number, zpos: number) {
        //if not staked, stake
        
        //if staked, owner of stake dies (even if self)
        
        //if claimed:
        //      by self: check if stake loop exists and add to claim
        //      by other: update stake data in cell without updating claim
        if (this.showLogs) {
            print("NetworkerTS: TEST - Starting send test");
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                print("NetworkerTS: TEST - Grid not ready, cannot send");
            }
            return;
        }
        
        // Use currentOrPendingValue as recommended in documentation
        const currentData = this.gridData.currentOrPendingValue;
        if (!currentData) {
            if (this.showLogs) {
                print("NetworkerTS: TEST - Grid data is null, cannot send");
            }
            return;
        }
        
        //z is vertical (thus multiply by height) and x is horizontal and is 1:1 with cells
        let idx = this.height * zpos + xpos
        if (idx < 0 || idx >= currentData.length) {
            if (this.showLogs) {
                print("NetworkerTS: TEST - Invalid index: " + idx);
            }
            return;
        }
        
        //use current data at current index to determine next step
        const oldValue = currentData[idx];
        const claimedBy = oldValue.x;
        const stakedBy = oldValue.y;
        // new value will be claimed by none staked by client ID
        const newValue = new vec2(0, ID);
        
        if (this.showLogs) {
            print("NetworkerTS: TEST - Updating position (" + xpos + ", " + zpos + ") to " + newValue);
        }
        
        // Create a copy of the current array
        let newArray = [...currentData];
        //update specified index with new value
        newArray[idx] = newValue;
        
        // Set the new value
        this.gridData.setPendingValue(newArray);
        
        if (this.showLogs) {
            print("NetworkerTS: TEST - Successfully sent update");
        }
    }
    
    
    // function for accessing grid data
    getData(ID: number, xpos: number, zpos: number): vec2 {
        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Starting receive test");
        }
        
        
        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Testing position (" + xpos + ", " + zpos + ")");
        }
        
        if (!this.gridReady) {
            if (this.showLogs) {
                print("NetworkerTS: TEST RECEIVE - Grid not ready, cannot test");
            }
            return;
        }
        
        // Calculate the array index based on x and y
        let idx = this.height * zpos + xpos;
        
        // Use currentOrPendingValue as recommended in documentation
        const currentData = this.gridData.currentOrPendingValue;
        
        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Calculated index: " + idx);
            print("NetworkerTS: TEST RECEIVE - Grid data currentOrPendingValue: " + currentData);
            print("NetworkerTS: TEST RECEIVE - Grid data currentOrPendingValue length: " + (currentData ? currentData.length : "undefined"));
        }
        
        if (!currentData) {
            print("NetworkerTS: TEST RECEIVE - Grid data is null, cannot test");
            return;
        }
        
        // Check if index is OOB
        if (idx < 0 || idx >= currentData.length) {
            print("NetworkerTS: TEST RECEIVE - Invalid grid index: " + idx + " for x=" + xpos + ", y=" + zpos);
            return;
        }
        
        // get the cell vector from the specified retieve index
        let cellVec = currentData[idx];
        
        if (this.showLogs) {
            print("NetworkerTS: TEST RECEIVE - Retrieved cellVec: " + cellVec);
        }
        
        if (cellVec === undefined) {
            print("NetworkerTS: TEST RECEIVE - ERROR - cellVec is undefined at index " + idx);
        } else {
            print("NetworkerTS: TEST RECEIVE - SUCCESS - cellVec retrieved: " + cellVec);
        }
        //return the vector 2 that the parameters requested
        return cellVec;
    }
    
    
    
}
