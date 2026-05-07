from pyv2xlib import v2xlib
from binascii import hexlify, unhexlify


def spat_decoder(hex_msg):
    '''
    Decode SPAT message from hex string to dictionary

    Args:
        hex_msg (str): hex string of SPAT message

    Returns:
        dict: SPAT message in dictionary format
    '''
    # decode SPAT message
    header_msg = v2xlib.MessageFrame.MessageFrame

    header_msg.from_uper_ws(unhexlify(hex_msg))
    msg = header_msg()

    if msg['messageId'] == 19:
        # SPAT
        spat = msg['value'][1]

        return spat
    else:
        print('Message ID is not 19, it is:', msg['messageId'])
        return msg['value'][1]
