/**
 * The apps host's process (ADR-0037): the control plane's image, started
 * with `node dist/apps-host/main.js` in its own Fly app. It reads only its
 * own variables; none of the control plane's secrets are set on that app.
 */

import { createServer } from "node:http";
import { createAppsHost } from "./server.js";

function required(name: string, v: string | undefined): string {
	if (!v) {
		console.error(
			`[apps-host] ${name} is not set: the apps host cannot check tickets or reach apps, and will not start`,
		);
		process.exit(1);
	}
	return v;
}

const host = createAppsHost({
	ticketKey: required("APPS_TICKET_KEY", process.env.APPS_TICKET_KEY),
	signingKey: required("APPS_SIGNING_KEY", process.env.APPS_SIGNING_KEY),
	cockpitUrl: required("COCKPIT_URL", process.env.COCKPIT_URL),
	onFly: Boolean(process.env.FLY_APP_NAME),
});
const port = Number(process.env.APPS_HOST_PORT ?? 8080);
const server = createServer(host.app);
host.attach(server);
server.listen(port, "::", () =>
	console.log(`[apps-host] listening on ${port}`),
);
