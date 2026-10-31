# syntax=docker/dockerfile:1

# Tape recorder (see tapeRecorder.mjs). Node 24 runs the shared
# src/overlays/takerOrders.ts directly (built-in type stripping), so there's
# no build step and no npm dependencies.
FROM node:24-alpine
WORKDIR /app

COPY src/overlays/takerOrders.ts ./src/overlays/takerOrders.ts
COPY recorder/tapeRecorder.mjs ./recorder/tapeRecorder.mjs

# A named volume starts as a copy of this directory, ownership included.
RUN mkdir -p /data && chown node:node /data
ENV TAPE_DIR=/data
ENV TAPE_PORT=8787
VOLUME /data
EXPOSE 8787

USER node
CMD ["node", "recorder/tapeRecorder.mjs"]
