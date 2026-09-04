# PathPulse edge engine — SIH26168, Phase 16.
#
# ★ WHY THE BUILD CONTEXT IS THE REPOSITORY ROOT ★
# The engine's entire value is that it runs the SAME nav-core the phone runs.
# That package is a workspace sibling, not a published dependency, so a context
# scoped to packages/edge-engine could not see it — and the image would either
# fail to build or, worse, silently pull a different version from a registry.
# Build from the root:
#
#     docker build -f packages/edge-engine/Dockerfile -t pathpulse-edge .
#
# Then, reading an external IMU off the network and broadcasting the estimate:
#
#     docker run --rm -p 5555:5555/udp pathpulse-edge \
#       --udp-in 5555 --rate 200 --udp-out 5556 --udp-host host.docker.internal
#
# Or with no hardware at all, which is how the benchmark runs:
#
#     docker run --rm pathpulse-edge --grade FOG --rate 200 --seconds 60

FROM node:22-alpine

# tini, because a navigation process must die when it is told to. Node as PID 1
# does not forward SIGTERM to its children or reap zombies, so `docker stop`
# waits the full ten seconds and then kills it — which on a vehicle is the
# difference between a clean shutdown and a corrupt output file.
RUN apk add --no-cache tini

WORKDIR /app
RUN corepack enable

# Manifests first, so a change to source code does not re-resolve the whole
# dependency tree. Only the packages the edge engine actually needs are copied:
# apps/web is a Next.js application with three hundred megabytes of dependencies
# and nothing the engine imports.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/nav-core/package.json      packages/nav-core/
COPY packages/sensor-sources/package.json packages/sensor-sources/
COPY packages/edge-engine/package.json    packages/edge-engine/

# --ignore-scripts: nothing here needs a native build, and running arbitrary
# install scripts inside an image that will sit on a vehicle is not a thing to
# do by default. `serialport` is deliberately absent for the same reason; add
# it in a derived image if the deployment has a serial IMU.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @pathpulse/edge-engine... || \
    pnpm install --ignore-scripts --filter @pathpulse/edge-engine...

COPY packages/nav-core       packages/nav-core
COPY packages/sensor-sources packages/sensor-sources
COPY packages/edge-engine    packages/edge-engine

# The engine is pure TypeScript run through tsx — the same source the tests and
# the phone's bundle are built from. There is no compile step to skew, which is
# the point of Golden Rule #1 and is worth preserving all the way to the image.
WORKDIR /app/packages/edge-engine

# UDP in. Publish with -p 5555:5555/udp; the /udp matters and is the usual
# thing to forget.
EXPOSE 5555/udp

# ★ THE ENTRYPOINT HAS TO NAME THE PROGRAM ★
# With `ENTRYPOINT ["/sbin/tini", "--"]` alone, `docker run pathpulse-edge
# --grade FOG` asks tini to execute a file called "--grade", and it says so:
#   [FATAL tini (7)] exec --grade failed: No such file or directory
# Naming the program here means every argument the user passes is forwarded to
# the CLI, which is what `docker run <image> --grade FOG --rate 200` should
# obviously do.
ENTRYPOINT ["/sbin/tini", "--", "pnpm", "exec", "tsx", "src/cli.ts"]

# No arguments: print the usage rather than starting a run nobody asked for.
CMD ["--help"]
