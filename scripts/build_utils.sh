#!/bin/bash

# check if TERM is set
# though it's not the actual way to detect if TTY is available, it's a good enough approximation for our use case
HAS_TTY=true
if [ -z "$TERM" ] || [ "$TERM" = "dumb" ]; then
    HAS_TTY=false
fi

# default colors
C_RST=$(echo -e "\e[0m")
C_ERR=$(echo -e "\e[31m")
C_OK=$(echo -e "\e[32m")
C_WARN=$(echo -e "\e[33m")
C_INFO=$(echo -e "\e[35m")

# if TTY is available, use colors
if [ "$HAS_TTY" = true ]; then
    C_RST="$(tput sgr0)"
    C_ERR="$(tput setaf 1)"
    C_OK="$(tput setaf 2)"
    C_WARN="$(tput setaf 3)"
    C_INFO="$(tput setaf 5)"
fi

msg() { printf '%s%s%s\n' $2 "$1" $C_RST; }

msg_info() { msg "$1" $C_INFO; }
msg_ok() { msg "$1" $C_OK; }
msg_err() { msg "$1" $C_ERR; }
msg_warn() { msg "$1" $C_WARN; }

DOCKER_BUILD_TAG=${DOCKER_BUILD_TAG:-ghcr.io/jetkvm/buildkit:latest}
DOCKER_BUILD_DEBUG=${DOCKER_BUILD_DEBUG:-false}
DOCKER_BUILD_CONTEXT_DIR=${DOCKER_BUILD_CONTEXT_DIR:-$(mktemp -d)}
DOCKER_GO_CACHE_DIR=${DOCKER_GO_CACHE_DIR:-$(pwd)/.cache}

BUILD_IN_DOCKER=${BUILD_IN_DOCKER:-false}
BUILDKIT_VERSION=v0.2.5
BUILDKIT_SHA256=0f1b6d59b746ca3c894561ba2ad7bc6358a5ae2bce1f053c6e4eebc14a8780fd

function prepare_native_buildkit_archive() {
    local compressed="${DOCKER_BUILD_CONTEXT_DIR}/buildkit.tar.zst"
    local archive="${DOCKER_BUILD_CONTEXT_DIR}/buildkit.tar"
    if ! command -v curl > /dev/null 2>&1; then
        msg_err "Error: curl is required to prepare the native buildkit"
        return 1
    fi
    if ! command -v unzstd > /dev/null 2>&1; then
        msg_err "Error: unzstd is required to prepare the native buildkit"
        return 1
    fi
    curl --fail --location --silent --show-error \
        --output "${compressed}" \
        "https://github.com/jetkvm/rv1106-system/releases/download/${BUILDKIT_VERSION}/buildkit.tar.zst" \
        || return 1
    if command -v sha256sum > /dev/null 2>&1; then
        echo "${BUILDKIT_SHA256}  ${compressed}" | sha256sum --check - || return 1
    elif command -v shasum > /dev/null 2>&1; then
        echo "${BUILDKIT_SHA256}  ${compressed}" | shasum -a 256 --check - || return 1
    else
        msg_err "Error: sha256sum or shasum is required to verify the native buildkit"
        return 1
    fi
    unzstd --long=31 --force "${compressed}" -o "${archive}" || return 1
    rm -f "${compressed}"
    tar -tf "${archive}" \
        ./bin/arm-rockchip830-linux-uclibcgnueabihf-gcc > /dev/null \
        || return 1
}



function prepare_docker_build_context() {
    msg_info "▶ Preparing docker build context ..."
    cp .devcontainer/install-deps.sh \
        go.mod \
        go.sum \
        Dockerfile.build \
        "${DOCKER_BUILD_CONTEXT_DIR}"
    cat > "${DOCKER_BUILD_CONTEXT_DIR}/entrypoint.sh" << 'EOF'
#!/bin/bash
git config --global --add safe.directory /build
exec $@
EOF
    chmod +x "${DOCKER_BUILD_CONTEXT_DIR}/entrypoint.sh"
    prepare_native_buildkit_archive || return 1
}

function build_docker_image() {
    if [ "$JETKVM_INSIDE_DOCKER" = 1 ]; then
        msg_err "Error: already running inside Docker"
        exit
    fi

    BUILD_ARGS=""
    if [ "$DOCKER_BUILD_DEBUG" = true ]; then
        BUILD_ARGS="$BUILD_ARGS --progress=plain --no-cache"
    fi

    msg_info "Checking if Docker is available ..."
    if ! command -v docker &> /dev/null; then
        msg_err "Error: Docker is not installed"
        exit 1
    fi

    DOCKER_BIN=$(which docker)
    if echo "$DOCKER_BIN" | grep -q "snap"; then
        msg_warn "Docker was installed using snap, this may cause issues with the build."
        msg_warn "Please consider installing Docker Engine from: https://docs.docker.com/engine/install/ubuntu/"
    fi

    prepare_docker_build_context || return 1
    pushd "${DOCKER_BUILD_CONTEXT_DIR}" > /dev/null
    msg_info "▶ Building docker image ..."
    local build_status
    if docker build $BUILD_ARGS -t "${DOCKER_BUILD_TAG}" -f Dockerfile.build .; then
        build_status=0
    else
        build_status=$?
    fi
    popd > /dev/null
    rm -f "${DOCKER_BUILD_CONTEXT_DIR}/buildkit.tar"
    return "${build_status}"
}

function do_make() {
    DOCKER_BUILD_ARGS="--rm"
    if [ "$HAS_TTY" = true ]; then
        DOCKER_BUILD_ARGS="$DOCKER_BUILD_ARGS --interactive --tty"
    fi
    if [ "$BUILD_IN_DOCKER" = true ]; then
        msg_info "▶ Building the project in Docker ..."
        set -x
        docker run \
            --env JETKVM_INSIDE_DOCKER=1 \
            -v "$(pwd):/build" \
            -v "${DOCKER_GO_CACHE_DIR}:/root/.cache/go-build" \
            ${DOCKER_BUILD_TAG} make "$@"
        set +x
    else
        msg_info "▶ Building the project in host ..."
        set -x
        make "$@"
        set +x
    fi
}