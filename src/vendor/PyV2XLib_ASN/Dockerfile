FROM ubuntu
RUN apt-get update && apt-get install -y python3 python3-pip
WORKDIR /PyV2XLib
COPY . .
RUN pip3 install .
