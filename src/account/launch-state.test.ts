import { describe, expect, it } from "vitest";
import { launchViewForAccount } from "./launch-state";

const verifiedAccount = {
  id: "account-1",
  email: "sameer@example.com",
  displayName: "Sameer",
  emailVerified: true,
  githubLinked: false,
};

describe("launch state", () => {
  it("starts unsigned and unverified people in onboarding", () => {
    expect(launchViewForAccount(null)).toBe("onboarding");
    expect(launchViewForAccount({ ...verifiedAccount, emailVerified: false })).toBe("onboarding");
  });

  it("opens the workbench only for a verified saved session", () => {
    expect(launchViewForAccount(verifiedAccount)).toBe("workspace");
  });
});
