from pyv2xlib import v2xlib
from binascii import hexlify, unhexlify


def map_decoder(hex_msg):
    '''
    Decode MAP message from hex string to dictionary

    Args:
        hex_msg (str): hex string of MAP message

    Returns:
        dict: MAP message in dictionary format
    '''
    # decode MAP message
    header_msg = v2xlib.MessageFrame.MessageFrame

    header_msg.from_uper_ws(unhexlify(hex_msg))
    msg = header_msg()

    if msg['messageId'] == 18:
        # MAP
        map = msg['value'][1]
        print(f"keys:{[val for val in msg['value'][0]]}")
        if 'intersections'not in map:
            print("No intersection in this map message!")
        for intersection in map.get('intersections', []):
            
            intersection['refPoint']['lat'] /= 1e7
            intersection['refPoint']['long'] /= 1e7
            if intersection['refPoint'].get('elevation'):
                intersection['refPoint']['elevation'] /= 10

            if intersection.get('laneWidth'):
                intersection['laneWidth'] /= 100

            for speed_limit in intersection.get('speedLimits', []):
                speed_limit['speed'] = speed_limit['speed'] / 50 if speed_limit['speed'] != 8191 else None
            
            for lane in intersection['laneSet']:
                if lane['laneAttributes']['directionalUse'][0] == 0:
                    lane['laneAttributes']['directionalUse'] = 'ingressPath'
                elif lane['laneAttributes']['directionalUse'][0] == 1:
                    lane['laneAttributes']['directionalUse'] = 'egressPath'
                
                if lane['laneAttributes']['sharedWith'][0] == 0:
                    lane['laneAttributes']['sharedWith'] = 'overlappingLaneDescriptionProvided'
                elif lane['laneAttributes']['sharedWith'][0] == 1:
                    lane['laneAttributes']['sharedWith'] = 'multipleLanesTreatedAsOneLane'
                elif lane['laneAttributes']['sharedWith'][0] == 2:
                    lane['laneAttributes']['sharedWith'] = 'otherNonMotorizedTrafficTypes'
                elif lane['laneAttributes']['sharedWith'][0] == 3:
                    lane['laneAttributes']['sharedWith'] = 'individualMotorizedVehicleTraffic'
                elif lane['laneAttributes']['sharedWith'][0] == 4:
                    lane['laneAttributes']['sharedWith'] = 'busVehicleTraffic'
                elif lane['laneAttributes']['sharedWith'][0] == 5:
                    lane['laneAttributes']['sharedWith'] = 'taxiVehicleTraffic'
                elif lane['laneAttributes']['sharedWith'][0] == 6:
                    lane['laneAttributes']['sharedWith'] = 'pedestriansTraffic'
                elif lane['laneAttributes']['sharedWith'][0] == 7:
                    lane['laneAttributes']['sharedWith'] = 'cyclistVehicleTraffic'
                elif lane['laneAttributes']['sharedWith'][0] == 8:
                    lane['laneAttributes']['sharedWith'] = 'trackedVehicleTraffic'
                elif lane['laneAttributes']['sharedWith'][0] == 9:
                    lane['laneAttributes']['sharedWith'] = 'reserved'
                else:
                    #lane['laneAttributes']['sharedWith'] = 'unknown'
                    #lane['laneAttributes']['sharedWith'] = lane['laneAttributes']['sharedWith'][0]
                    pass
                if lane.get('connectsTo123'):
                    for idx_connect, connect in enumerate(lane['connectsTo']):
                        if connect:
                            lane['laneAttributes']['connections'].append(dict(connect))  
                      
                if lane['laneAttributes']['laneType'][0] == 'vehicle':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'isVehicleRevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'isVehicleFlyOverLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'hovLaneUseOnly')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'restrictedToBusUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'restrictedToTaxiUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 5:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'restrictedFromPublicUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 6:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'hasIRbeaconCoverage')
                    elif lane['laneAttributes']['laneType'][1][0] == 7:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'permissionOnRequest')
                elif lane['laneAttributes']['laneType'][0] == 'crosswalk':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'crosswalkRevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'bicyleUseAllowed')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'isXwalkFlyOverLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'fixedCycleTime')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'biDirectionalCycleTimes')
                    elif lane['laneAttributes']['laneType'][1][0] == 5:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'hasPushToWalkButton')
                    elif lane['laneAttributes']['laneType'][1][0] == 6:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'audioSupport')
                    elif lane['laneAttributes']['laneType'][1][0] == 7:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'rfSignalRequestPresent')
                    elif lane['laneAttributes']['laneType'][1][0] == 8:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'unsignalizedSegmentsPresent')
                elif lane['laneAttributes']['laneType'][0] == 'bikeLane':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'bikeRevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'pedestrianUseAllowed')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'isBikeFlyOverLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'fixedCycleTime')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'biDirectionalCycleTimes')
                    elif lane['laneAttributes']['laneType'][1][0] == 5:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'isolatedByBarrier')
                    elif lane['laneAttributes']['laneType'][1][0] == 6:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'unsignalizedSegmentsPresent')
                elif lane['laneAttributes']['laneType'][0] == 'sidewalk':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'sidewalk-RevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'bicyleUseAllowed')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'isSidewalkFlyOverLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'walkBikes')
                elif lane['laneAttributes']['laneType'][0] == 'median':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'median-RevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'median')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'whiteLineHashing')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripedLines')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'doubleStripedLines')
                    elif lane['laneAttributes']['laneType'][1][0] == 5:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'trafficCones')
                    elif lane['laneAttributes']['laneType'][1][0] == 6:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'constructionBarrier')
                    elif lane['laneAttributes']['laneType'][1][0] == 7:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'trafficChannels')
                    elif lane['laneAttributes']['laneType'][1][0] == 8:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'lowCurbs')
                    elif lane['laneAttributes']['laneType'][1][0] == 9:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'highCurbs')
                    elif lane['laneAttributes']['laneType'][1][0] in [10, 11, 12, 13, 14, 15]:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], '')
                elif lane['laneAttributes']['laneType'][0] == 'striping':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripeToConnectingLanesRevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripeDrawOnLeft')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripeDrawOnRight')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripeToConnectingLanesLeft')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripeToConnectingLanesRight')
                    elif lane['laneAttributes']['laneType'][1][0] == 5:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'stripeToConnectingLanesAhead')
                    elif lane['laneAttributes']['laneType'][1][0] in [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], '')
                elif lane['laneAttributes']['laneType'][0] == 'trackedVehicle':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'spec-RevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'spec-commuterRailRoadTrack')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'spec-lightRailRoadTrack')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'spec-heavyRailRoadTrack')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'spec-otherRailType')
                    elif lane['laneAttributes']['laneType'][1][0] in [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], '')
                elif lane['laneAttributes']['laneType'][0] == 'parking':
                    if lane['laneAttributes']['laneType'][1][0] == 0:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'parkingRevocableLane')
                    elif lane['laneAttributes']['laneType'][1][0] == 1:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'parallelParkingInUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 2:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'headInParkingInUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 3:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'doNotParkZone')
                    elif lane['laneAttributes']['laneType'][1][0] == 4:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'parkingForBusUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 5:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'parkingForTaxiUse')
                    elif lane['laneAttributes']['laneType'][1][0] == 6:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], 'noPublicParkingUse')
                    elif lane['laneAttributes']['laneType'][1][0] in [7, 8, 9, 10, 11, 12, 13, 14, 15]:
                        lane['laneAttributes']['laneType'] = (lane['laneAttributes']['laneType'][0], '')
                
                if lane['laneAttributes'].get('maneuvers'):
                    if lane['laneAttributes']['maneuvers'][0] == 0:
                        lane['laneAttributes']['maneuvers'] = 'maneuverStraightAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 1:
                        lane['laneAttributes']['maneuvers'] = 'maneuverLeftAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 2:
                        lane['laneAttributes']['maneuvers'] = 'maneuverRightAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 3:
                        lane['laneAttributes']['maneuvers'] = 'maneuverUTurnAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 4:
                        lane['laneAttributes']['maneuvers'] = 'maneuverLeftTurnOnRedAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 5:
                        lane['laneAttributes']['maneuvers'] = 'maneuverRightTurnOnRedAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 6:
                        lane['laneAttributes']['maneuvers'] = 'maneuverLaneChangeAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 7:
                        lane['laneAttributes']['maneuvers'] = 'maneuverNoStoppingAllowed'
                    elif lane['laneAttributes']['maneuvers'][0] == 8:
                        lane['laneAttributes']['maneuvers'] = 'yieldAllwaysRequired'
                    elif lane['laneAttributes']['maneuvers'][0] == 9:   
                        lane['laneAttributes']['maneuvers'] = 'goWithHalt'
                    elif lane['laneAttributes']['maneuvers'][0] == 10:
                        lane['laneAttributes']['maneuvers'] = 'straightAheadYield'
                    elif lane['laneAttributes']['maneuvers'][0] == 11:
                        lane['laneAttributes']['maneuvers'] = 'caution'
                    elif lane['laneAttributes']['maneuvers'][0] == 12:
                        lane['laneAttributes']['maneuvers'] = 'reserved1'

                if lane['nodeList'][0] == 'nodes':
                    for node in lane['nodeList'][1]:
                        if node['delta'][0] == 'node-LatLon':
                            node['delta'][1]['lon'] /= 1e7
                            node['delta'][1]['lat'] /= 1e7
                        else:
                            node['delta'][1]['x'] /= 100
                            node['delta'][1]['y'] /= 100
                        if node.get('attributes'):
                            if node['attributes'].get('dWidth'):
                                node['attributes']['dWidth'] /= 100
                            if node['attributes'].get('dElevation'):
                                node['attributes']['dElevation'] /= 100
                elif lane['nodeList'][0] == 'computed':
                    if lane['nodeList'][1].get('rotateXY'):
                        lane['nodeList'][1]['scaleXaxis'] *= 0.0125
                    if lane['nodeList'][1].get('scaleXaxis'):
                        lane['nodeList'][1]['scaleXaxis'] /= 20
                    if lane['nodeList'][1].get('scaleYaxis'):
                        lane['nodeList'][1]['scaleYaxis'] /= 20

        return map
    else:
        print('Message ID is not 19, it is:', msg['messageId'])
        return msg['value'][1]
