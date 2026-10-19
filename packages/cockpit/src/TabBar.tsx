export interface TabDef<T extends string> {
	id: T;
	label: string;
}

/** A row of tab buttons: "main" for a panel's tabs, "home" for the start page's sections. */
export function TabBar<T extends string>({
	tabs,
	value,
	onChange,
	variant = "main",
}: {
	tabs: readonly TabDef<T>[];
	value: T;
	onChange: (id: T) => void;
	variant?: "main" | "home";
}) {
	const home = variant === "home";
	return (
		<nav className={home ? "home-tabs" : "tabs"}>
			{tabs.map((t) => (
				<button
					key={t.id}
					type="button"
					className={
						home
							? `home-tab${value === t.id ? " home-tab-active" : ""}`
							: `tab ${value === t.id ? "on" : ""}`
					}
					onClick={() => onChange(t.id)}
				>
					{t.label}
				</button>
			))}
		</nav>
	);
}
