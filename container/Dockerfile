# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium + dev tools
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    wget \
    git \
    jq \
    ripgrep \
    fd-find \
    bat \
    tree \
    unzip \
    zip \
    python3 \
    python3-pip \
    sqlite3 \
    pandoc \
    hunspell \
    poppler-utils \
    cmake \
    rclone \
    direnv \
    libreoffice-nogui \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install ast-grep from GitHub releases
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then SG_ARCH="aarch64"; else SG_ARCH="x86_64"; fi \
    && curl -fsSL -o /tmp/sg.zip "https://github.com/ast-grep/ast-grep/releases/latest/download/app-${SG_ARCH}-unknown-linux-gnu.zip" \
    && unzip -o /tmp/sg.zip -d /usr/local/bin/ && rm /tmp/sg.zip \
    && chmod +x /usr/local/bin/sg

# Install ripgrep-all from GitHub releases
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then RGA_ARCH="aarch64"; else RGA_ARCH="x86_64"; fi \
    && curl -fsSL "https://github.com/phiresky/ripgrep-all/releases/download/v0.10.10/ripgrep_all-v0.10.10-${RGA_ARCH}-unknown-linux-gnu.tar.gz" \
       | tar xz --strip-components=1 -C /usr/local/bin/ --wildcards '*/rga' '*/rga-preproc'

# Install CLI tools from GitHub releases (each separate so failures don't cascade)
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then A="aarch64"; else A="x86_64"; fi \
    && curl -fsSL "https://github.com/typst/typst/releases/latest/download/typst-${A}-unknown-linux-musl.tar.xz" \
       | tar xJ --strip-components=1 -C /usr/local/bin/ --wildcards '*/typst' \
    && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-${A}-unknown-linux-musl.tar.gz" \
       | tar xz -C /usr/local/bin/ \
    && curl -fsSL "https://github.com/bootandy/dust/releases/latest/download/dust-v1.2.4-${A}-unknown-linux-musl.tar.gz" \
       | tar xz --strip-components=1 -C /usr/local/bin/ --wildcards '*/dust' \
    && curl -fsSL "https://github.com/Myriad-Dreamin/tinymist/releases/latest/download/tinymist-${A}-unknown-linux-musl.tar.gz" \
       | tar xz -C /usr/local/bin/ \
    && curl -fsSL "https://github.com/medialab/xan/releases/latest/download/xan-${A}-unknown-linux-gnu.tar.gz" \
       | tar xz -C /usr/local/bin/ \
    && if [ "$ARCH" = "arm64" ]; then OBS_ARCH="arm64"; else OBS_ARCH="amd64"; fi \
    && curl -fsSL "https://github.com/Yakitrak/obsidian-cli/releases/latest/download/obsidian-cli_0.2.3_linux_${OBS_ARCH}.tar.gz" \
       | tar xz -C /usr/local/bin/

# Install pixi, uv, bun, and semtools
RUN curl -fsSL https://pixi.sh/install.sh | PIXI_HOME=/usr/local bash \
    && curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && pip3 install --break-system-packages semtools || true

# Install playwright and seleniumbase
RUN pip3 install --break-system-packages playwright seleniumbase \
    && npx playwright install --with-deps chromium || true

# Install Google Cloud SDK
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then G_ARCH="arm"; else G_ARCH="x86_64"; fi \
    && curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${G_ARCH}.tar.gz" \
       | tar xz -C /opt/ \
    && /opt/google-cloud-sdk/install.sh --quiet --path-update=false \
    && ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud \
    && ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil \
    && ln -sf /opt/google-cloud-sdk/bin/bq /usr/local/bin/bq

# fd-find installs as 'fdfind', bat as 'batcat' on Debian — symlink
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/batcat /usr/local/bin/bat

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/local/lib/node_modules

# Install agent-browser, playwright, and claude-code globally
# Remove Python playwright binary first to avoid conflict with npm playwright
RUN rm -f /usr/local/bin/playwright && npm install -g agent-browser playwright @anthropic-ai/claude-code

# Copy CDP helper script
COPY scripts/cdp-browser /usr/local/bin/cdp-browser
RUN chmod +x /usr/local/bin/cdp-browser

# Copy pre-compiled nlm binary (cross-compiled for Linux arm64)
COPY bin/nlm-linux /usr/local/bin/nlm
RUN chmod +x /usr/local/bin/nlm

# CLI tools will be mounted from host at /mnt/projects
# Symlinks created at runtime via entrypoint

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint script
# Reads input from /workspace/ipc/input.json (written by host before container start)
# Compiles CLI tools from mounted source at runtime (host=macOS, container=Linux)
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
# Also create .config dir so CLIs (obsidian-cli, etc.) can write config
RUN chown -R node:node /workspace \
    && mkdir -p /home/node/.config \
    && chown -R node:node /home/node/.config

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
