/**
 * The lifecycle action a mission's status offers. A mission in `error` (a
 * failed resume or resize; its volume is intact) offers Resume: its own
 * error message says to resume it, and the resume route recovers a
 * destroyed machine. Mid-transition and destroyed missions offer nothing.
 */
export function statusAction(
	status: string | null | undefined,
): "suspend" | "resume" | null {
	if (status === "running") return "suspend";
	if (status === "suspended" || status === "error") return "resume";
	return null;
}
