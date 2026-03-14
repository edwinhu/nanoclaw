#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

# Cross-compile Go binaries for Linux arm64 (host is macOS)
GO="${GO:-$(command -v go 2>/dev/null || echo /opt/homebrew/bin/go)}"
mkdir -p bin

if [ -d "$HOME/projects/nlm" ]; then
  echo "Cross-compiling nlm..."
  GOOS=linux GOARCH=arm64 "$GO" build -C "$HOME/projects/nlm" -o "$SCRIPT_DIR/bin/nlm-linux" -ldflags="-s -w" ./cmd/nlm
fi

# Cross-compile Bun/TypeScript CLIs for Linux arm64
BUN="${BUN:-$(command -v bun 2>/dev/null || echo /opt/homebrew/bin/bun)}"

compile_cli() {
  local cli="$1" entry="$2"
  local cli_dir="$HOME/projects/$cli"
  if [ -d "$cli_dir" ]; then
    local bin_name="${cli%-cli}"
    echo "Cross-compiling $bin_name..."
    "$BUN" build --compile --target=bun-linux-arm64 "$cli_dir/$entry" --outfile "$SCRIPT_DIR/bin/${bin_name}-linux"
  fi
}

compile_cli superhuman-cli src/cli.ts
compile_cli morgen-cli src/cli.ts
compile_cli readwise-cli src/main.ts

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker
docker build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Installed CLI tools:"
echo "  - superhuman (from ~/projects/superhuman-cli)"
echo "  - morgen (from ~/projects/morgen-cli)"
echo "  - readwise (from ~/projects/readwise-cli)"
echo ""
echo "Test with:"
echo "  docker run -i --rm ${IMAGE_NAME}:${TAG} superhuman --version"
echo "  docker run -i --rm ${IMAGE_NAME}:${TAG} morgen --version"
