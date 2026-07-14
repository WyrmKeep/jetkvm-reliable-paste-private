#!/bin/bash

SUDO_PATH=$(which sudo)
function sudo() {
  if [ "$UID" -eq 0 ]; then
    "$@"
  else
    ${SUDO_PATH} "$@"
  fi
}

set -ex

export DEBIAN_FRONTEND=noninteractive
ARCH="$(dpkg --print-architecture)"
APT_PACKAGES=(
  iputils-ping
  build-essential
  device-tree-compiler
  gperf
  gdb-multiarch
  libnl-3-dev
  libdbus-1-dev
  libelf-dev
  libmpc-dev
  dwarves
  bc
  openssl
  flex
  bison
  libssl-dev
  python3
  python-is-python3
  texinfo
  kmod
  cmake
  wget
  zstd
  python3-venv
  python3-kconfiglib
)

if [ "${ARCH}" = "amd64" ]; then
  APT_PACKAGES+=(g++-multilib gcc-multilib)
elif [ "${ARCH}" = "arm64" ]; then
  sudo dpkg --add-architecture amd64
  APT_PACKAGES+=(libc6:amd64 libstdc++6:amd64 zlib1g:amd64)
else
  echo "Skipping cross-compiler host libraries on ${ARCH}."
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
sudo rm -rf /var/lib/apt/lists/*

# Install the native buildkit unless a container stage already supplied it.
if [ "${JETKVM_SKIP_BUILDKIT_INSTALL:-0}" != "1" ]; then
  BUILDKIT_VERSION="v0.2.5"
  BUILDKIT_SHA256="0f1b6d59b746ca3c894561ba2ad7bc6358a5ae2bce1f053c6e4eebc14a8780fd"
  BUILDKIT_TMPDIR="$(mktemp -d)"
  trap 'rm -rf "${BUILDKIT_TMPDIR}"' EXIT
  pushd "${BUILDKIT_TMPDIR}" > /dev/null
  wget --quiet --output-document=buildkit.tar.zst \
    "https://github.com/jetkvm/rv1106-system/releases/download/${BUILDKIT_VERSION}/buildkit.tar.zst"
  echo "${BUILDKIT_SHA256}  buildkit.tar.zst" | sha256sum --check -
  sudo mkdir -p /opt/jetkvm-native-buildkit
  sudo tar --use-compress-program="unzstd --long=31" \
    -xf buildkit.tar.zst -C /opt/jetkvm-native-buildkit
  test -x /opt/jetkvm-native-buildkit/bin/arm-rockchip830-linux-uclibcgnueabihf-gcc
  popd > /dev/null
  rm -rf "${BUILDKIT_TMPDIR}"
  trap - EXIT
fi
