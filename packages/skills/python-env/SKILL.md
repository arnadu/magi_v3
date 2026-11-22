---
name: python-env
description: Run Python and add packages the platform does not have - your own environment, which lasts across restarts and is used by your scripts, background jobs and apps.
---

# Python environment

Run Python with **`magi-python3`** (or `#!/usr/bin/env magi-python3` as a script's first line),
never plain `python3`, which has no packages.

The platform's environment already has: numpy, pandas, scipy, scikit-learn, matplotlib, plotly,
requests, yfinance, Jupyter, Gradio and notebook widgets (`ipywidgets`). Check before you
install: `magi-python3 -c "import seaborn"`.

## Adding a package

```bash
S=$SHARED_DIR/skills/_platform/python-env/scripts
bash $S/python-env.sh install seaborn statsmodels   # creates your environment the first time
bash $S/python-env.sh list                          # what you added
```

Your environment is `$WORKDIR/.venv`. It sees every platform package and holds only what you
add; from then on `magi-python3`, your background jobs and your apps (notebooks, Gradio, sites)
run with it. It is yours alone: teammates don't see your packages, and you don't see theirs.

## Never

- `pip install --user`, or packages under your home folder (`~`): the home folder is erased
  whenever the mission is resumed. Your workdir is not.
- A virtual environment of your own elsewhere, or in the shared folder: your apps would not use
  it, and anything in the shared folder can be changed by every teammate.
- Upgrade Jupyter, Gradio or `ipywidgets`: your apps are served with the platform's versions, and
  `install` refuses a package that would replace them.
