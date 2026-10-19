import { useState } from "react";
import { useAuthState, useView } from "./app-hooks";
import { CopilotPanel } from "./CopilotPanel";
import { DraftEditor } from "./DraftEditor";
import { Header } from "./Header";
import { HomeView } from "./HomeView";
import { LoadingView } from "./LoadingView";
import { LoginScreen } from "./LoginScreen";
import { MissionDashboard } from "./MissionDashboard";

/** The cockpit shell: sign-in gate, then the start page, a draft editor or one mission's dashboard. */
export function App() {
	const authState = useAuthState();
	const [refreshKey, setRefreshKey] = useState(0);
	const view = useView(refreshKey, authState.status);

	if (authState.status === "loading") return <LoadingView />;

	// Proactive: no session at all. Reactive backstop: view.kind === "auth" is
	// set when a fetch 401s mid-session (cookie expired) even though
	// authState hadn't caught up yet — same login screen either way.
	if (authState.status === "signed-out" || view.kind === "auth") {
		return (
			<LoginScreen
				initialError={
					authState.status === "signed-out" ? authState.error : null
				}
			/>
		);
	}

	// useView()'s effect is a no-op while signed out, so "loading" only lasts
	// until the first fetch once signed in.
	if (view.kind === "loading") return <LoadingView />;

	if (view.kind === "error") {
		return (
			<div className="app">
				<Header subtitle="error" />
				<main>
					<p className="mut">Could not load objectives: {view.message}</p>
				</main>
			</div>
		);
	}

	if (view.kind === "draft") {
		return (
			<div className="app-shell">
				<div className="app">
					<Header subtitle="editing draft" />
					<main className="tab-body">
						<DraftEditor
							missionId={view.missionId}
							onBack={() => {
								window.location.search = "";
							}}
							onLaunched={(id) => {
								window.location.search = `?mission=${encodeURIComponent(id)}`;
							}}
						/>
					</main>
				</div>
				<CopilotPanel />
			</div>
		);
	}

	if (view.kind === "picker") {
		return (
			<HomeView
				missions={view.missions}
				onRefresh={() => setRefreshKey((k) => k + 1)}
			/>
		);
	}

	return <MissionDashboard view={view} />;
}
