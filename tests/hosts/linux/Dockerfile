# Runtime/toolchain image only. The runner stages an explicit source allowlist.
FROM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev xvfb xauth dbus-x11 \
    libgl1-mesa-dri fonts-dejavu-core python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 quixi
WORKDIR /work
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 LIBGL_ALWAYS_SOFTWARE=1
