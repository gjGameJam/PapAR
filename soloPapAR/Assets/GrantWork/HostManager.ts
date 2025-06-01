@component
export class HostManager extends BaseScriptComponent {
    //connection id of game host
    gameHost: String = null;
    
    //script to manager the grid claim modification permissions
    onAwake() {
        //listen for session controller 
    }
    
    //only the host can make direct modifications to the grid
    isHost(): Boolean {
        return false;
    }
    
    //this is the userId of the client with this script
    //sessionController.getLocalUserId()
    
    //meet with spectacles team to:
    //1: improve/refine understand on below plan 
    //2: get multiple previews of same session emulating multiplayer
    
    //grid networking plan:
    //ASK: encapsulate all player logic into prefab to be spawned on join?
    //TODO: use CreateRealtimeStore to store grid as general data store in multiplayer session
    //    have owner if needed (doesn't seem to be with ownership.unowned) with realtime store 
    //    and send grid updates to grid claimer to use real time store grid
    //TODO: update player visuals minimap to use grid's real time store updates
    
    
    
}
