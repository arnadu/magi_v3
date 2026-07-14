/**
 * Shared GitHub REST API helper — used by the control-plane copilot's own
 * GitHub tools (copilot-tools.ts) and by the mission-copilot GitHub proxy
 * (mission-copilot-router.ts). GH_TOKEN never leaves the control plane;
 * the proxy is what lets execution-plane agents reach GitHub without it.
 */

export const GITHUB_REPO = process.env.GITHUB_REPO ?? "arnadu/magi_v3";
const GH_TOKEN = process.env.GH_TOKEN;

export async function ghFetch(
	path: string,
	options: RequestInit = {},
): Promise<Response> {
	if (!GH_TOKEN)
		throw new Error(
			"GH_TOKEN is not set — cannot access GitHub API. Set it in bootstrap.sh.",
		);
	return fetch(`https://api.github.com${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			Accept: "application/vnd.github.v3+json",
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}
