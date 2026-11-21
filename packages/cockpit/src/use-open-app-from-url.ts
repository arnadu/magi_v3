import { useEffect, useState } from "react";
import { reopenApp } from "./data";
import { openAppParam, withoutOpenAppParam } from "./open-app-param";

export type OpenFromUrl =
	| { status: "none" }
	| { status: "opening" }
	| { status: "error"; message: string };

/**
 * When the apps host sent the operator here (`/?openApp=<capability>`), ask
 * the control plane for a fresh ticket once signed in, and go to the app in
 * this tab. Anyone but the mission's owner gets an error, never the app.
 */
export function useOpenAppFromUrl(signedIn: boolean): OpenFromUrl {
	const [capability] = useState(() => openAppParam(window.location.search));
	const [state, setState] = useState<OpenFromUrl>(
		capability ? { status: "opening" } : { status: "none" },
	);
	useEffect(() => {
		if (!capability || !signedIn) return;
		window.history.replaceState(
			null,
			"",
			withoutOpenAppParam(window.location.href),
		);
		reopenApp(capability)
			.then((r) => window.location.replace(r.url))
			.catch((e: Error) => setState({ status: "error", message: e.message }));
	}, [capability, signedIn]);
	return state;
}
