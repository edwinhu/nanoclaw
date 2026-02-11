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
