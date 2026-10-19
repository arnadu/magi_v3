import { useState } from "react";
import { signOut } from "./auth";

/**
 * Ends the server session and the Firebase sign-in. App re-renders to the
 * login screen through subscribeAuth, so nothing here navigates.
 */
export function SignOutButton() {
	const [busy, setBusy] = useState(false);
	return (
		<button
			type="button"
			className="header-back-btn"
			disabled={busy}
			onClick={() => {
				setBusy(true);
				void signOut().finally(() => setBusy(false));
			}}
		>
			{busy ? "Signing out…" : "Sign out"}
		</button>
	);
}
