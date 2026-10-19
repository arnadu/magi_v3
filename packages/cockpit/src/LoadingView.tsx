import { Header } from "./Header";

export function LoadingView() {
	return (
		<div className="app">
			<Header subtitle="loading…" />
			<main>
				<p className="mut">Loading objectives…</p>
			</main>
		</div>
	);
}
