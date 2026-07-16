import type { TraceAccount } from "./types";

export type TraceLaunchView = "checking" | "onboarding" | "workspace";

/** A verified persisted session is the only automatic route into the workbench. */
export function launchViewForAccount(account: TraceAccount | null): Exclude<TraceLaunchView, "checking"> {
  return account?.emailVerified ? "workspace" : "onboarding";
}
