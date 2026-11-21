# Runs the same HTTP/process checks as the host against prebuilt production WASM.
FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
RUN apt-get update && apt-get install --yes --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts --no-audit --no-fund pnpm@12.22.0
WORKDIR /work
COPY . .
RUN pnpm install --frozen-lockfile
ENV CI=true WRANGLER_SEND_METRICS=false
ENTRYPOINT ["node", "scripts/testing/docker-suites.mts"]
