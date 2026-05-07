import os


file_list = sorted(os.listdir('J2735_J3224_202506'))
invalid_byte_list = [0xC2, 0xB0, 0xb5]
output_folder = 'J2735_J3224'

for file in file_list:
    if file.endswith('.asn'):
        with open(os.path.join('J2735_J3224_202506', file), 'rb') as f:
            data = f.read()
            # Here you can process the data as needed
            positions = [b for i, b in enumerate(data) if b in invalid_byte_list]
            positions = list(set(positions))  # Remove duplicates
            if len(positions) > 0:
                print(f"Found invalid bytes in {file}: {positions}")
            cleaned = data
            for b in positions:
                cleaned = cleaned.replace(bytes([b]), b'')
            with open(os.path.join(output_folder, file), 'wb') as out_file:
                out_file.write(cleaned)
    else:
        print(f"Skipping non-JSON file: {file}")
