#!/usr/bin/env bash
#
# build-docker.sh — Build and push the eb-mcp Docker image to AWS ECR.
#
# Usage:
#   ./build-docker.sh [TAG]
#
# Arguments:
#   TAG   (optional) Image tag to apply. Defaults to "latest".
#         Example: ./build-docker.sh v1.2.3
#
# Prerequisites:
#   - Docker is installed and running.
#   - AWS CLI (v2 recommended) is installed and configured with credentials
#     that have ECR push permissions for the target repository.
#   - The target ECR repository already exists:
#       650089657562.dkr.ecr.ap-southeast-1.amazonaws.com/eb/mcp-service
#
# What this script does:
#   1. Builds the Docker image from the local dockerfile.
#   2. Authenticates Docker to the AWS ECR registry.
#   3. Tags the image for the ECR repository.
#   4. Pushes the image to ECR.
#

set -euo pipefail

LOCAL_IMAGE="eb/mcp-service"
ECR_REGISTRY="650089657562.dkr.ecr.ap-southeast-1.amazonaws.com"
ECR_REPO="eb/mcp-service"
AWS_REGION="ap-southeast-1"
TAG="${1:-latest}"

ECR_IMAGE="${ECR_REGISTRY}/${ECR_REPO}:${TAG}"

# ── 1. Build ────────────────────────────────────────────────────────────────
echo "▶ Building Docker image ${LOCAL_IMAGE}:${TAG} ..."
docker build -t "${LOCAL_IMAGE}:${TAG}" -f dockerfile .
echo "✔ Build succeeded."

# ── 2. Authenticate to ECR ──────────────────────────────────────────────────
echo "▶ Authenticating Docker to ECR (${ECR_REGISTRY}) ..."
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
echo "✔ Authentication succeeded."

# ── 3. Tag for ECR ──────────────────────────────────────────────────────────
echo "▶ Tagging image as ${ECR_IMAGE} ..."
docker tag "${LOCAL_IMAGE}:${TAG}" "${ECR_IMAGE}"

# ── 4. Push to ECR ──────────────────────────────────────────────────────────
echo "▶ Pushing ${ECR_IMAGE} ..."
docker push "${ECR_IMAGE}"
echo "✔ Push succeeded."

echo ""
echo "Image available at:"
echo "  ${ECR_IMAGE}"
echo ""
echo "To run locally:"
echo "  docker run -p 8080:8080 ${LOCAL_IMAGE}:${TAG}"
