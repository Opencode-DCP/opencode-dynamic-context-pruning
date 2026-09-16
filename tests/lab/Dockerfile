FROM node:24-bookworm-slim

ARG V2=2.0.4
ARG V1=1.18.29
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/v2 @opencode/cli@${V2} \
    && npm install --prefix /opt/v1 opencode-ai@${V1}

ENV PATH="/opt/v2/node_modules/.bin:${PATH}" \
    HOME=/lab/home \
    XDG_CONFIG_HOME=/lab/home/config \
    XDG_DATA_HOME=/lab/home/data \
    XDG_CACHE_HOME=/lab/home/cache \
    XDG_STATE_HOME=/lab/home/state \
    REQUEST_LOG_DIR=/lab/logs
WORKDIR /lab/project
CMD ["opencode2", "--version"]
