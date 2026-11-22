#!/usr/bin/env bash
# python-env/scripts/python-env.sh — your own Python environment, layered on the platform's.
#
#   python-env.sh install <package> [<package>...]   # creates the environment if needed
#   python-env.sh list                               # the packages you added
#   python-env.sh create                             # just create it
#   python-env.sh which                              # the interpreter magi-python3 runs
#
# The environment is $WORKDIR/.venv, on the mission's volume (it survives a resume). It
# sees every platform package; pip adds only what is missing. magi-python3, background
# jobs and your apps (notebooks, Gradio) use it automatically.
#
# Environment: WORKDIR (required).

set -euo pipefail

die() { echo "python-env: $*" >&2; exit 1; }
[[ -n "${WORKDIR:-}" ]] || die "WORKDIR is not set"
PLATFORM=/opt/magi/venv
VENV="$WORKDIR/.venv"
# The packages the platform's apps are served with: an install may not replace them.
PROTECTED='^(jupyterlab|jupyter-server|jupyter-collaboration|jupyter-server-ydoc|ipykernel|ipywidgets|jupyterlab-widgets|widgetsnbextension|gradio|gradio-client)=='

purelib() { "$1" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'; }

create() {
    if [[ -x "$VENV/bin/python3" ]]; then return 0; fi
    "$PLATFORM/bin/python3" -m venv "$VENV"
    # A .pth line puts the platform's packages after the environment's own: pip sees
    # them as installed, and a package you install yourself takes precedence.
    purelib "$PLATFORM/bin/python3" > "$(purelib "$VENV/bin/python3")/_magi_platform.pth"
    echo "Created $VENV (on top of the platform's packages)."
}

case "${1:-}" in
    create) create ;;
    install)
        shift; [[ $# -gt 0 ]] || die "usage: python-env.sh install <package> [...]"
        create
        CONSTRAINTS="$(mktemp)"; trap 'rm -f "$CONSTRAINTS"' EXIT
        "$PLATFORM/bin/python3" -m pip freeze 2>/dev/null \
            | sed -E 's/_/-/g' | grep -iE "$PROTECTED" > "$CONSTRAINTS" || true
        "$VENV/bin/python3" -m pip install --no-cache-dir --disable-pip-version-check \
            -c "$CONSTRAINTS" "$@"
        ;;
    list)
        [[ -x "$VENV/bin/python3" ]] || { echo "No environment of your own yet: magi-python3 runs the platform's ($PLATFORM)."; exit 0; }
        "$VENV/bin/python3" -m pip list --disable-pip-version-check --path "$(purelib "$VENV/bin/python3")" 2>/dev/null \
            | grep -v -E '^(pip|setuptools) '
        ;;
    which)
        if [[ -x "$VENV/bin/python3" ]]; then echo "$VENV/bin/python3"; else echo "$PLATFORM/bin/python3"; fi ;;
    *) die "usage: python-env.sh install <package>... | list | create | which" ;;
esac
