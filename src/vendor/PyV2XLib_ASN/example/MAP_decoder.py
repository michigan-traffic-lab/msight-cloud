from pyv2xlib.MAPDecoder import map_decoder


if __name__ == '__main__':
    example_map_file = 'example/map/1037_Ellsworth & State - Apr 8 2025.MAP'
    with open(example_map_file, 'r') as f:
        hex_msg = f.read().strip()
    map_data = map_decoder(hex_msg)
    print(map_data)
