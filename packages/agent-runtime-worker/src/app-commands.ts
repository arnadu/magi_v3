/**
 * The command line and environment for each kind of app (ADR-0037 decision
 * 7). The platform builds them; an agent supplies only the kind and its
 * files, so binding to loopback and the base path hold by construction.
 *
 * Every app runs through `/usr/local/bin/magi-app` as its owner, whose sudo
 * rule keeps exactly the variables built here (`env_keep`). The Jupyter token
 * travels in the environment, never on the command line: `/proc/<pid>/cmdline`
 * is readable by every user, `/proc/<pid>/environ` only by the owner.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppKind } from "@magi/agent-config";

export const MAGI_APP = "/usr/local/bin/magi-app";
/** The platform's Python environment, built into the image (read-only to agents). */
export const PLATFORM_VENV = "/opt/magi/venv";
export const PLATFORM_PYTHON = `${PLATFORM_VENV}/bin/python3`;
/** An agent's own environment, layered on the platform's (the python-env skill). */
export const AGENT_VENV = ".venv";
/**
 * The platform's copy, beside this package (root-owned in the image under
 * /app/packages), never the agent-writable copy under shared/skills.
 */
const SERVE_SITE = fileURLToPath(
	new URL("../../skills/serve-app/scripts/serve-site.py", import.meta.url),
);

export interface AppLaunch {
	/** Arguments after `magi-app`. */
	argv: string[];
	/** The working directory of the app. */
	cwd: string;
	/** The app's environment, beyond PATH and HOME. */
	env: Record<string, string>;
	/** Whether the monitor hop keeps the `/a/<capability>` prefix (JupyterLab) or removes it. */
	keepPrefix: boolean;
}

export interface AppLaunchInput {
	kind: AppKind;
	/** The folder (jupyter, site) or Python file (gradio), absolute and already contained. */
	path: string;
	/** `site` only: an optional handlers file, absolute and already contained. */
	handlers?: string;
	port: number;
	/** `/a/<capability>` as the browser sees it, without a trailing slash. */
	basePath: string;
	/** `jupyter` only: the token the monitor hop adds to every request. */
	jupyterToken?: string;
	/**
	 * The interpreter: the owner's own environment when it has one, so the app
	 * (and a notebook's kernel) sees the packages the owner's scripts see;
	 * otherwise `PLATFORM_PYTHON`.
	 */
	python: string;
}

/**
 * A JupyterLab started from an agent's environment still finds the platform's
 * front end, extensions (widgets, collaboration) and their settings, which
 * live under the platform environment, not under the agent's.
 */
const JUPYTER_PLATFORM_ENV = {
	JUPYTER_PATH: join(PLATFORM_VENV, "share/jupyter"),
	JUPYTER_CONFIG_PATH: join(PLATFORM_VENV, "etc/jupyter"),
	JUPYTERLAB_DIR: join(PLATFORM_VENV, "share/jupyter/lab"),
};

export function appLaunch(app: AppLaunchInput): AppLaunch {
	const port = String(app.port);
	switch (app.kind) {
		case "jupyter":
			if (!app.jupyterToken) throw new Error("a jupyter app needs a token");
			return {
				argv: [
					app.python,
					"-m",
					"jupyterlab",
					"--no-browser",
					"--ServerApp.ip=127.0.0.1",
					`--ServerApp.port=${port}`,
					"--ServerApp.port_retries=0",
					`--ServerApp.base_url=${app.basePath}/`,
					`--ServerApp.root_dir=${app.path}`,
					"--ServerApp.terminals_enabled=False",
					// The browser reaches it through the apps host, whose origin
					// (a port per app) the daemon does not know; the apps host
					// checks the origin, and the token stays required.
					"--ServerApp.allow_origin=*",
					"--ServerApp.allow_remote_access=True",
					"--YDocExtension.file_poll_interval=1",
					"--YDocExtension.document_save_delay=1",
				],
				cwd: app.path,
				env: {
					PORT: port,
					BASE_PATH: app.basePath,
					JUPYTER_TOKEN: app.jupyterToken,
					...JUPYTER_PLATFORM_ENV,
				},
				keepPrefix: true,
			};
		case "gradio":
			return {
				argv: [app.python, app.path],
				cwd: dirname(app.path),
				env: {
					PORT: port,
					BASE_PATH: app.basePath,
					GRADIO_SERVER_NAME: "127.0.0.1",
					GRADIO_SERVER_PORT: port,
					GRADIO_ROOT_PATH: app.basePath,
					GRADIO_ANALYTICS_ENABLED: "False",
					// Its run history keeps the page path (the capability) and every
					// call's inputs and outputs in localStorage (spike, 2026-11-21).
					GRADIO_RUN_HISTORY: "False",
				},
				keepPrefix: false,
			};
		case "site":
			return {
				argv: [
					app.python,
					SERVE_SITE,
					"--root",
					app.path,
					...(app.handlers ? ["--handlers", app.handlers] : []),
				],
				cwd: app.path,
				env: { PORT: port, BASE_PATH: app.basePath },
				keepPrefix: false,
			};
	}
}

/** Every variable an app may receive: the `env_keep` list of magi-app's sudo rule. */
export const APP_ENV_KEEP = [
	"PORT",
	"BASE_PATH",
	"JUPYTER_TOKEN",
	"GRADIO_SERVER_NAME",
	"GRADIO_SERVER_PORT",
	"GRADIO_ROOT_PATH",
	"GRADIO_ANALYTICS_ENABLED",
	"GRADIO_RUN_HISTORY",
	"JUPYTER_PATH",
	"JUPYTER_CONFIG_PATH",
	"JUPYTERLAB_DIR",
] as const;
