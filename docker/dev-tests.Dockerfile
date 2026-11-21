# Runs the same HTTP/process checks as the host against prebuilt production WASM.
ARG NODE_IMAGE=node:24.22.3-trixie-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install --yes --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.4.1
WORKDIR /work
COPY . .
RUN pnpm install --frozen-lockfile
ENV CI=true WRANGLER_SEND_METRICS=false
ENTRYPOINT ["node", "scripts/testing/docker-suites.mts"]
