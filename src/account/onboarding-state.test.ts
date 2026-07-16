import { describe, expect, it } from "vitest";
import { afterVerificationRefresh, chooseOnboardingStart, nextForAccount } from "./onboarding-state";

const verifiedOwner = { id: "1", email: "owner@example.com", displayName: "Owner", emailVerified: true, githubLinked: false };

describe("onboarding state", () => {
  it("keeps unsigned users in an explicit local path", () => {
    expect(chooseOnboardingStart("local", false)).toBe("local");
    expect(chooseOnboardingStart("invite", false)).toBe("sign-in");
    expect(chooseOnboardingStart("invite", true)).toBe("redeem");
  });

  it("takes owners through verification, GitHub, and app installation", () => {
    expect(nextForAccount({ ...verifiedOwner, emailVerified: false }, "owner")).toBe("verify");
    expect(nextForAccount(verifiedOwner, "owner")).toBe("github");
    expect(nextForAccount({ ...verifiedOwner, githubLinked: true }, "owner")).toBe("installation");
  });

  it("takes invitees into redemption before GitHub linking", () => {
    expect(nextForAccount({ ...verifiedOwner, githubLinked: true }, "invitee")).toBe("redeem");
    expect(afterVerificationRefresh(null, "invitee")).toBe("sign-in");
    expect(afterVerificationRefresh(verifiedOwner, "invitee")).toBe("redeem");
  });
});
