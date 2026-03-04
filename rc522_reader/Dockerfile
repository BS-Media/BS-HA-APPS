ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache \
  nodejs npm \
  python3 make g++ linux-headers

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY lib ./lib
COPY index.js ./index.js
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
