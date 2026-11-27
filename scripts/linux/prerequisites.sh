# Sourced by build.sh, which enables errexit and pipefail.
confirm_setup() {
  local answer
  if [[ ! -t 0 ]]; then
    echo "$1 Run npm run build:linux in a terminal to approve setup." >&2
    return 1
  fi
  read -r -p "$1 [y/N] " answer || return 1
  [[ $answer == [yY] || ${answer,,} == yes ]]
}

install_packages() {
  if ! command -v apt-get >/dev/null; then
    echo "Automatic installation requires APT. Install $* using your system package manager." >&2
    return 1
  fi
  confirm_setup "Download and install $* using APT?"
  "${admin[@]}" apt-get update
  "${admin[@]}" apt-get install -y --no-remove "$@"
}

prepare_linux_builder() {
  local -a admin=() packages=(docker.io)
  local endpoint daemon_arch foreign_arch probe handler
  docker_cmd=(docker)
  if (( EUID != 0 )); then admin=(sudo); fi

  if ! command -v docker >/dev/null; then
    if command -v apt-cache >/dev/null && apt-cache show docker-buildx >/dev/null 2>&1; then
      packages+=(docker-buildx)
    fi
    install_packages "${packages[@]}"
  fi

  if ! daemon_arch=$(docker info --format '{{.Architecture}}'); then
    endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
    if [[ $endpoint != unix:///var/run/docker.sock && $endpoint != unix:///run/docker.sock ]]; then
      echo "Connect to the configured Docker engine ($endpoint) and retry." >&2
      return 1
    fi
    if [[ ! -S /var/run/docker.sock ]] || ! systemctl is-active --quiet docker 2>/dev/null; then
      confirm_setup "Start the local Docker service?"
      "${admin[@]}" systemctl start docker
    fi
    if ! daemon_arch=$(docker info --format '{{.Architecture}}' 2>/dev/null); then
      confirm_setup "Use sudo for Docker commands during this build?"
      # docker run --env NAME reads build settings from the client environment.
      local IFS=,
      docker_cmd=(sudo "--preserve-env=${build_env[*]}" docker)
      daemon_arch=$("${docker_cmd[@]}" info --format '{{.Architecture}}')
    fi
  fi

  case "$daemon_arch" in
    aarch64|arm64) foreign_arch=amd64; handler=qemu-x86_64 ;;
    x86_64|amd64) foreign_arch=arm64; handler=qemu-aarch64 ;;
    *) echo "Unsupported Docker engine architecture: $daemon_arch" >&2; return 1 ;;
  esac

  # An actual execution also recognizes emulation provided by Docker Desktop.
  # Preserve registry, networking, and daemon errors as their own failures.
  if probe=$("${docker_cmd[@]}" run --rm --platform "linux/$foreign_arch" busybox:1.36 /bin/true 2>&1); then
    return 0
  fi
  echo "$probe" >&2
  [[ $probe == *"exec format error"* ]] || return 1
  endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
  if [[ $endpoint != unix:///var/run/docker.sock && $endpoint != unix:///run/docker.sock ]]; then
    echo "Enable linux/$foreign_arch emulation on the configured Docker engine ($endpoint)." >&2
    return 1
  fi
  if [[ $(dpkg-query -W -f='${db:Status-Status}' qemu-user-static 2>/dev/null) == installed ]]; then
    confirm_setup "Enable the installed QEMU handler for linux/$foreign_arch?"
  else
    install_packages qemu-user-static
  fi
  # On elementary OS and Ubuntu the package supplies systemd binfmt rules.
  if [[ -f /usr/lib/binfmt.d/$handler.conf ]]; then
    "${admin[@]}" systemctl restart systemd-binfmt
  elif command -v update-binfmts >/dev/null; then
    "${admin[@]}" update-binfmts --enable "$handler"
  fi
  "${docker_cmd[@]}" run --rm --platform "linux/$foreign_arch" busybox:1.36 /bin/true
}
