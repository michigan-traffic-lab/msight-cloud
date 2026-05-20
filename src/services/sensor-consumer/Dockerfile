# Build context: repo root (so src/vendor/PyV2XLib_ASN is accessible)
FROM python:3.12-slim

WORKDIR /app

# Install Python dependencies first (layer cache)
COPY src/services/sensor-consumer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install local pyv2xlib package
COPY src/vendor/PyV2XLib_ASN ./PyV2XLib_ASN
RUN pip install --no-cache-dir ./PyV2XLib_ASN

# Application code
COPY src/services/sensor-consumer/consumer.py .
COPY src/services/sensor-consumer/radius_broadcaster.py .

CMD ["python", "-u", "consumer.py"]
