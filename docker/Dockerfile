FROM haskell:9.12.2

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl ca-certificates xz-utils zstd gzip tar unzip git make procps jq \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

ENV PREFIX=/opt/ghc-wasm
RUN curl -fsSL https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/raw/master/bootstrap.sh \
  | FLAVOUR=9.12 sh

ENV BASH_ENV=/opt/ghc-wasm/env
RUN echo 'source /opt/ghc-wasm/env' >> /etc/bash.bashrc

RUN npm install -g pnpm@11 \
  && npm install -g wrangler@4.106.0

WORKDIR /work
CMD ["bash"]
