/**
 * The cockpit's API client, one module per domain under ./api. The cockpit
 * is served same-origin by the control plane, so the magi_session cookie
 * carries auth. `/missions/:id/*` is proxied to that mission's monitor
 * (unreachable while suspended); `/api/missions/:id/*` is control-plane-native
 * and works whatever the mission's state.
 */
export * from "./api/config";
export * from "./api/conversations";
export * from "./api/copilot";
export * from "./api/drafts";
export * from "./api/files";
export * from "./api/http";
export * from "./api/limits";
export * from "./api/missions";
export * from "./api/schedule";
export * from "./api/templates";
export * from "./api/trace";
export * from "./api/transcripts";
