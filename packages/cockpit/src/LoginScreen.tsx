import { useState } from "react";
import { signInWithApiKey, signInWithGoogle } from "./auth";

/** Ports index.html's #sign-in-overlay to the cockpit — same two sign-in paths, same copy. */
export function LoginScreen({ initialError }: { initialError: string | null }) {
	const [error, setError] = useState(initialError);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);

	async function handleGoogle() {
		setError(null);
		setBusy(true);
		const err = await signInWithGoogle();
		setBusy(false);
		if (err) setError(err);
	}

	async function handleKey() {
		setError(null);
		setBusy(true);
		const err = await signInWithApiKey(key);
		setBusy(false);
		if (err) setError(err);
	}

	return (
		<div className="app">
			<main className="login-main">
				<div className="login-box">
					<h2>MAGI</h2>
					<p className="mut">
						Sign in with Google, or use an admin API key for local dev.
					</p>
					<button
						type="button"
						className="btn-primary login-google"
						disabled={busy}
						onClick={handleGoogle}
					>
						Sign in with Google
					</button>
					<div className="login-divider">
						<span>or</span>
					</div>
					<label htmlFor="api-key-input">Admin API key</label>
					<input
						id="api-key-input"
						type="password"
						value={key}
						disabled={busy}
						onChange={(e) => setKey(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleKey();
						}}
						placeholder="CONTROL_API_KEY from .env"
					/>
					<button
						type="button"
						className="btn-primary login-key"
						disabled={busy}
						onClick={handleKey}
					>
						Sign in with key
					</button>
					{error && <p className="error-msg">{error}</p>}
				</div>
			</main>
		</div>
	);
}
