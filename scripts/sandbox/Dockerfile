FROM node:24-bookworm-slim

ARG PACKAGE=@opencode/cli
ARG VERSION=2.0.4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/opencode ${PACKAGE}@${VERSION}

ENV HOME=/lab/home \
    XDG_CONFIG_HOME=/lab/home/config \
    XDG_DATA_HOME=/lab/home/data \
    XDG_CACHE_HOME=/lab/home/cache \
    XDG_STATE_HOME=/lab/home/state \
    OPENCODE_CONFIG_DIR=/lab/home/config/opencode \
    PWD=/lab/project
WORKDIR /lab/project
CMD ["node", "/launcher/run.mjs"]
