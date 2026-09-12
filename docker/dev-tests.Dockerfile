# Runs the same HTTP/process checks as the host against prebuilt production WASM.
ARG NODE_IMAGE=node:24.8.0-trixie-slim
FROM ${NODE_IMAGE}
RUN npm install --global pnpm@12.4.1
WORKDIR /work
COPY . .
RUN pnpm install --frozen-lockfile
ENV CI=true WRANGLER_SEND_METRICS=false
ENTRYPOINT ["node", "examples/quickstart/test/Support/Dev/docker.mts"]
