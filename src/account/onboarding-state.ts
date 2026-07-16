import type { TraceAccount } from "./types";

export type OnboardingIntent = "owner" | "invitee";
export type OnboardingScreen = "choice" | "sign-up" | "sign-in" | "verify" | "github" | "installation" | "redeem";

export function chooseOnboardingStart(choice: "local" | "sign-up" | "sign-in" | "invite", signedIn: boolean): "local" | OnboardingScreen {
  if (choice === "local") return "local";
  if (choice === "sign-up") return "sign-up";
  if (choice === "invite") return signedIn ? "redeem" : "sign-in";
  return "sign-in";
}

export function nextForAccount(account: TraceAccount, intent: OnboardingIntent): OnboardingScreen {
  if (!account.emailVerified) return "verify";
  if (intent === "invitee") return "redeem";
  return account.githubLinked ? "installation" : "github";
}

export function afterVerificationRefresh(account: TraceAccount | null, intent: OnboardingIntent): OnboardingScreen {
  return account ? nextForAccount(account, intent) : "sign-in";
}
