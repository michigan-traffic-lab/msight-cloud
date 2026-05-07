from pyv2xlib import v2xlib
from binascii import hexlify, unhexlify


def bsm_decoder(hex_msg):
    '''
    Decode BSM message from hex string to dictionary

    Args:
        hex_msg (str): hex string of BSM message

    Returns:
        dict: BSM message in dictionary format
    '''
    # decode BSM message
    header_msg = v2xlib.MessageFrame.MessageFrame

    header_msg.from_uper_ws(unhexlify(hex_msg))
    msg = header_msg()

    if msg['messageId'] == 20:
        # BSM
        bsm = msg['value'][1]

        try:
            bsm['coreData']['id'] = bsm['coreData']['id'].decode('utf-8')
        except Exception as e:
            bsm['coreData']['id'] = bsm['coreData']['id']
        if 'secMark' in list(bsm['coreData'].keys()):
            bsm['coreData']['secMark'] /= 1000
        bsm['coreData']['lat'] /= 10 ** 7
        bsm['coreData']['long'] /= 10 ** 7
        if 'elev' in list(bsm['coreData'].keys()):
            bsm['coreData']['elev'] /= 10
        
        bsm['coreData']['accuracy']['semiMajor'] /= 20
        bsm['coreData']['accuracy']['semiMinor'] /= 20
        bsm['coreData']['accuracy']['orientation'] /= 65535 / 360

        bsm['coreData']['speed'] /= 50
        bsm['coreData']['heading'] *= 0.0125
        if bsm['coreData']['angle'] == 127:
            bsm['coreData']['angle'] = 'unavailable'
        else:
            bsm['coreData']['angle'] *= 1.5
        
        if 'accelSet' in list(bsm['coreData'].keys()):
            if 'lat' in list(bsm['coreData']['accelSet'].keys()):
                if bsm['coreData']['accelSet']['lat'] == 2001:
                    bsm['coreData']['accelSet']['lat'] = 'unavailable'
                else:
                    bsm['coreData']['accelSet']['lat'] /= 100
            if 'long' in list(bsm['coreData']['accelSet'].keys()):
                if bsm['coreData']['accelSet']['long'] == 2001:
                    bsm['coreData']['accelSet']['long'] = 'unavailable'
                else:
                    bsm['coreData']['accelSet']['long'] /= 100
            if 'vert' in list(bsm['coreData']['accelSet'].keys()):
                if bsm['coreData']['accelSet']['vert'] == -127:
                    bsm['coreData']['accelSet']['vert'] = 'unavailable'
                else:
                    bsm['coreData']['accelSet']['vert'] /= 50 / 9.80665
            if 'yaw' in list(bsm['coreData']['accelSet'].keys()):
                bsm['coreData']['accelSet']['yaw'] /= 100

        return bsm
    else:
        print('Message ID is not 20, it is:', msg['messageId'])
        return msg['value'][1]
