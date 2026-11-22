---
name: serve-app
description: Serve something the operator uses in a browser - a Jupyter notebook you work on together, a Gradio app, or a small website - and start, stop or remove it. The operator opens it from the Apps tab of the mission cockpit.
---

# Serve an app

An **app** is a program you write that the operator uses in their browser. The platform runs it
as you, on this machine, and the operator opens it from the **Apps** tab of the mission cockpit.
You never handle URLs, ports or passwords: the platform does.

Three kinds, and only these:

| Kind | Use it for | `--path` is |
|---|---|---|
| `jupyter` | A notebook you and the operator work on together | a folder (the notebooks live there) |
| `gradio` | An interactive tool: controls, charts, a model to play with | your app's `.py` file |
| `site` | A small website: pages, a little JavaScript, a few endpoints | a folder with `index.html` |

The folder or file must be in your workdir or the shared folder.

## Commands

```bash
S=$SHARED_DIR/skills/_platform/serve-app/scripts
bash $S/serve-app.sh declare forecast --kind gradio --path "$WORKDIR/apps/forecast/app.py" \
     --description "Next week's forecast for any city"
bash $S/serve-app.sh status               # every app of the mission
bash $S/serve-app.sh status forecast      # one app: state, port, memory, last error
bash $S/serve-app.sh stop forecast
bash $S/serve-app.sh start forecast
bash $S/serve-app.sh remove forecast
```

`declare` starts the app and waits until it answers (or fails, showing the end of its log).
Declaring again with the same name replaces it (for example after you changed its files).
Then **tell the operator** it is ready: "open `forecast` from the Apps tab".

What the platform does for you:
- runs the app as you, with no secrets, on a port only you and the platform can reach;
- restarts it if it crashes, up to 3 times an hour, then marks it `failed` and tells you;
- stops it after 4 hours unopened, and whenever the mission is suspended or the daemon restarts
  (start it again when needed);
- runs at most 3 apps of the mission at once; a start beyond that is refused, naming the ones
  running (stop one of yours, or ask the operator).

Your app's output goes to `$WORKDIR/logs/app-<name>.log`. Read it when something fails.

Your app runs with the same Python as `magi-python3`: the platform's packages, plus any you
added with the `python-env` skill (a notebook's kernel too). Install what it needs there, then
start it again.

## Gradio

Write a normal Gradio app and call `demo.launch()` with **no arguments**: the platform sets the
address, port and path. For example:

```python
import gradio as gr

def forecast(city, days):
    ...
    return chart

with gr.Blocks() as demo:
    city = gr.Textbox(label="City")
    days = gr.Slider(1, 14, value=7, step=1, label="Days")
    out = gr.Plot()
    gr.Button("Forecast").click(forecast, [city, days], out)

demo.launch()
```

Test it yourself while it runs: `curl -s http://127.0.0.1:<port>/` with the port from
`serve-app.sh status`.

## Website

Put `index.html` and its files in a folder. **Use relative links only** (`href="page2.html"`,
`src="img/logo.png"`, `fetch("api/items")`), never ones starting with `/`: the site lives under a
path of its own.

For a few endpoints, add a Python file and declare it with `--handlers`:

```python
# handlers.py
def handle(request):
    # request: method, path, query (dict of lists), headers, body (bytes)
    if request["path"] == "/api/items":
        return 200, {"items": ["a", "b"]}   # dict or list → JSON; str → HTML; bytes → a file
    return None                              # anything else: the folder's files
```

```bash
bash $S/serve-app.sh declare menu --kind site --path "$WORKDIR/apps/menu" \
     --handlers "$WORKDIR/apps/menu/handlers.py" --description "The hotel's menu"
```

## Notebook (JupyterLab)

Declare a folder; the operator opens JupyterLab on it and runs cells there. Notebooks are files
in that folder: you write and read them as files, and changes appear on both sides within a
second or so.
- **The operator sees only that folder.** Declare the folder that holds the notebook *and* the
  code and data it loads (or put the notebook beside them), and load them by relative paths.
  A module imported from elsewhere still runs, but the operator cannot open or read it.
- Interactive widgets (`ipywidgets`: `interact`, sliders, buttons) are installed.
- A module the notebook imports must not call `matplotlib.use("Agg")` when it is imported: it
  switches the notebook to saving files, and every plot silently disappears. Put that call under
  `if __name__ == "__main__":`, or add `%matplotlib inline` after the imports in the notebook.
- **Before you change a notebook the operator has open, message them first** ("I'm adding a
  cell to analysis.ipynb now"). Edits made at the same moment on both sides can be lost.
- Code the operator runs in the notebook runs as you, with your files: keep the folder to what
  the notebook needs.

## Memory

A notebook takes about 200 MB, a Gradio app about 165 MB, a website about 20 MB, on top of what
the mission already uses. Before serving more than one app, or a notebook with large data, ask
for a bigger machine (the `request-resources` skill).

## Never

- Start a server any other way (Bash, a background job): it would not be reachable, and is
  blocked from other machines.
- Use Gradio's `share=True`, or any tunnel: it would publish your app outside the platform.
- Keep mission data, or your app's own address, in the browser's storage (`localStorage`,
  `gr.BrowserState`): it is cleared each time the operator opens the app, and is not a safe place
  for data.
