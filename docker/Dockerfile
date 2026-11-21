FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM haskell:9.14.1

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates xz-utils zstd gzip tar unzip git make procps jq \
  && rm -rf /var/lib/apt/lists/*

ENV PREFIX=/opt/ghc-wasm
RUN curl -fsSL https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/raw/master/bootstrap.sh \
  | FLAVOUR=9.14 sh

ENV BASH_ENV=/opt/ghc-wasm/env
RUN echo 'source /opt/ghc-wasm/env' >> /etc/bash.bashrc

RUN npm install --global --ignore-scripts --no-audit --no-fund pnpm@12.22.0

ENV PATH="/opt/ghc-wasm/bin:${PATH}"

WORKDIR /work
CMD ["bash"]
