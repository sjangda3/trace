// @vitest-environment jsdom

import { act } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const accountApi = vi.hoisted(() => ({
  state: vi.fn(),
  pendingInvite: vi.fn(),
  pendingPasswordReset: vi.fn(),
  onDeepLink: vi.fn(),
  signIn: vi.fn(),
  listInstallations: vi.fn(),
  requestPasswordReset: vi.fn(),
  refreshState: vi.fn(),
  resendVerification: vi.fn(),
  beginGitHubLink: vi.fn(),
}));

const arrowHarness = vi.hoisted(() => ({
  updatePointer: vi.fn(),
  clearPointer: vi.fn(),
}));

const motionHarness = vi.hoisted(() => ({
  isPresent: true,
  reducedMotion: false,
  renders: [] as Array<{
    className: string | undefined;
    initial: unknown;
    animate: unknown;
    exit: unknown;
    transition: unknown;
  }>,
}));

vi.mock("./api", () => {
  class TraceAccountError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
      this.name = "TraceAccountError";
    }
  }

  return {
    traceAccountApi: accountApi,
    TraceAccountError,
  };
});

vi.mock("./OpeningArrowBackground", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  const OpeningArrowBackground = React.forwardRef(function MockOpeningArrow(
    _props,
    ref,
  ) {
    React.useImperativeHandle(ref, () => arrowHarness, []);
    return React.createElement("div", {
      "data-testid": "opening-background",
      "aria-hidden": "true",
    });
  });

  return {
    OpeningArrowBackground,
    canUpdateOpeningPointer: (
      isChoiceScreen: boolean,
      pointerType: string,
      pressure = 0,
    ) => isChoiceScreen && (
      pointerType === "mouse" || (pointerType === "pen" && pressure === 0)
    ),
  };
});

vi.mock("motion/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
      onAnimationComplete?: () => void;
    }
  >(function MotionDiv({
    initial,
    animate,
    exit,
    transition,
    onAnimationComplete,
    ...props
  }, ref) {
    motionHarness.renders.push({
      className: props.className,
      initial,
      animate,
      exit,
      transition,
    });
    React.useLayoutEffect(() => {
      onAnimationComplete?.();
    }, []);
    return <div ref={ref} {...props} />;
  });

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv },
    useIsPresent: () => motionHarness.isPresent,
    useReducedMotion: () => motionHarness.reducedMotion,
  };
});

let Onboarding: typeof import("./Onboarding").Onboarding;
let TraceAccountError: typeof import("./api").TraceAccountError;

beforeAll(async () => {
  ({ Onboarding } = await import("./Onboarding"));
  ({ TraceAccountError } = await import("./api"));
});

afterEach(cleanup);

beforeEach(() => {
  for (const mock of Object.values(accountApi)) mock.mockReset();
  arrowHarness.updatePointer.mockClear();
  arrowHarness.clearPointer.mockClear();
  motionHarness.isPresent = true;
  motionHarness.reducedMotion = false;
  motionHarness.renders.length = 0;
  accountApi.state.mockResolvedValue({
    availability: "ready",
    user: null,
    message: null,
  });
  accountApi.pendingInvite.mockResolvedValue({ pending: false });
  accountApi.pendingPasswordReset.mockResolvedValue({ pending: false });
  accountApi.onDeepLink.mockReturnValue(() => undefined);
  accountApi.listInstallations.mockResolvedValue([]);
});

function account(overrides: Partial<{
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  githubLinked: boolean;
}> = {}) {
  return {
    id: "account-1",
    email: "sameer@example.com",
    displayName: "Sameer",
    emailVerified: true,
    githubLinked: false,
    ...overrides,
  };
}

async function settleBootstrap() {
  await waitFor(() => {
    expect(accountApi.state).toHaveBeenCalledTimes(1);
    expect(accountApi.pendingInvite).toHaveBeenCalledTimes(1);
    expect(accountApi.pendingPasswordReset).toHaveBeenCalledTimes(1);
  });
  await act(async () => undefined);
}

async function openLogin(expectReady = true) {
  const user = userEvent.setup();
  render(<Onboarding onContinueLocal={vi.fn()} />);
  await settleBootstrap();

  const background = screen.getByTestId("opening-background");
  await user.click(screen.getByRole("button", { name: "Login" }));
  const form = await screen.findByRole("form", { name: "Sign in to Trace" });
  const email = within(form).getByLabelText("Email") as HTMLInputElement;
  const password = within(form).getByLabelText("Password") as HTMLInputElement;
  const submit = within(form).getByRole("button", { name: "Login" }) as HTMLButtonElement;
  if (expectReady) await waitFor(() => expect(submit.disabled).toBe(false));

  return { user, background, form, email, password, submit };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function latestOpeningMotion() {
  const render = motionHarness.renders.slice().reverse().find(
    (candidate) => candidate.className === "onboarding-opening-view",
  );
  expect(render).toBeDefined();
  return render!;
}

describe("opening account views", () => {
  it("keeps one background instance while replacing choices with the login form", async () => {
    const { background, email } = await openLogin();
    expect(screen.getByTestId("opening-background")).toBe(background);
    expect(screen.queryByRole("group", { name: "Account access" })).toBeNull();
    expect(document.activeElement).toBe(email);
  });

  it("uses labelled native fields, login autocomplete semantics, and a predictable focus order", async () => {
    const { user, form, email, password, submit } = await openLogin();

    expect(form.getAttribute("aria-labelledby")).toBe("opening-sign-in-title");
    expect(email.name).toBe("email");
    expect(email.type).toBe("email");
    expect(email.required).toBe(true);
    expect(email.getAttribute("inputmode")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect(email.getAttribute("autocapitalize")).toBe("none");
    expect(email.getAttribute("spellcheck")).toBe("false");
    expect(password.name).toBe("password");
    expect(password.type).toBe("password");
    expect(password.required).toBe(true);
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.hasAttribute("minlength")).toBe(false);

    expect(document.activeElement).toBe(email);
    await user.tab();
    expect(document.activeElement).toBe(password);
    await user.tab();
    expect(document.activeElement).toBe(submit);
    await user.tab();
    expect(document.activeElement).toBe(
      within(form).getByRole("button", { name: "Forgot password?" }),
    );
  });

  it("uses the authored present-view crossfade timing", async () => {
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    expect(latestOpeningMotion()).toMatchObject({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: 0.16, delay: 0.06, ease: "easeOut" },
    });
  });

  it("makes a non-present opening view inert and hidden during its exit", async () => {
    motionHarness.isPresent = false;
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    const openingView = document.querySelector<HTMLElement>(
      ".onboarding-opening-view",
    );
    expect(openingView?.dataset.present).toBe("false");
    expect(openingView?.getAttribute("aria-hidden")).toBe("true");
    expect(openingView?.hasAttribute("inert")).toBe(true);
    expect(latestOpeningMotion().transition).toEqual({
      duration: 0.12,
      ease: "easeIn",
    });
  });

  it("collapses the opening crossfade to 20ms for reduced motion", async () => {
    motionHarness.reducedMotion = true;
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    expect(latestOpeningMotion().transition).toEqual({ duration: 0.02 });
  });

  it("forwards mouse coordinates through one shared path across the choice field and both controls", async () => {
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    const field = screen.getByRole("region", { name: "Trace account access" });
    const login = screen.getByRole("button", { name: "Login" });
    const signup = screen.getByRole("button", { name: "Sign up" });

    fireEvent.pointerMove(field, {
      pointerType: "mouse",
      clientX: 80,
      clientY: 120,
    });
    fireEvent.pointerMove(login, {
      pointerType: "mouse",
      clientX: 410,
      clientY: 360,
    });
    fireEvent.pointerMove(signup, {
      pointerType: "mouse",
      clientX: 510,
      clientY: 360,
    });

    expect(arrowHarness.updatePointer.mock.calls).toEqual([
      [{ x: 80, y: 120 }],
      [{ x: 410, y: 360 }],
      [{ x: 510, y: 360 }],
    ]);
  });

  it.each(["move", "down"] as const)(
    "clears a hovering pen on pen contact via pointer%s while touch stays inert",
    async (contactEvent) => {
      render(<Onboarding onContinueLocal={vi.fn()} />);
      await settleBootstrap();
      const field = screen.getByRole("region", { name: "Trace account access" });

      fireEvent.pointerMove(field, {
        pointerType: "pen",
        pressure: 0,
        clientX: 140,
        clientY: 180,
      });
      expect(arrowHarness.updatePointer).toHaveBeenCalledWith({
        x: 140,
        y: 180,
      });

      const dispatchContact = contactEvent === "move"
        ? fireEvent.pointerMove
        : fireEvent.pointerDown;
      dispatchContact(field, {
        pointerType: "pen",
        pressure: 0.5,
        clientX: 150,
        clientY: 190,
      });

      expect(arrowHarness.clearPointer).toHaveBeenCalledTimes(1);
      expect(arrowHarness.updatePointer).toHaveBeenCalledTimes(1);

      fireEvent.pointerMove(field, {
        pointerType: "touch",
        pressure: 0.5,
        clientX: 160,
        clientY: 200,
      });
      fireEvent.pointerDown(field, {
        pointerType: "touch",
        pressure: 0.5,
        clientX: 160,
        clientY: 200,
      });

      expect(arrowHarness.clearPointer).toHaveBeenCalledTimes(1);
      expect(arrowHarness.updatePointer).toHaveBeenCalledTimes(1);
    },
  );

  it("forwards every rapid pointer move without a cooldown or throttle", async () => {
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    const field = screen.getByRole("region", { name: "Trace account access" });

    const points = Array.from({ length: 16 }, (_, index) => ({
      x: 240 + index,
      y: 320 - index,
    }));
    for (const point of points) {
      fireEvent.pointerMove(field, {
        pointerType: "mouse",
        clientX: point.x,
        clientY: point.y,
      });
    }

    expect(arrowHarness.updatePointer).toHaveBeenCalledTimes(points.length);
    expect(arrowHarness.updatePointer.mock.calls.map(([point]) => point))
      .toEqual(points);
  });

  it.each(["Login", "Sign up"])(
    "clears arrow repulsion when selecting %s",
    async (choice) => {
      const user = userEvent.setup();
      render(<Onboarding onContinueLocal={vi.fn()} />);
      await settleBootstrap();

      await user.click(screen.getByRole("button", { name: choice }));
      expect(arrowHarness.clearPointer).toHaveBeenCalled();
    },
  );

  it("clears arrow repulsion when the pointer leaves the opening field", async () => {
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    fireEvent.pointerLeave(
      screen.getByRole("region", { name: "Trace account access" }),
    );
    expect(arrowHarness.clearPointer).toHaveBeenCalledTimes(1);
  });

  it.each(["Login", "Sign up"])(
    "stops forwarding pointer updates after opening %s",
    async (choice) => {
      const user = userEvent.setup();
      render(<Onboarding onContinueLocal={vi.fn()} />);
      await settleBootstrap();

      await user.click(screen.getByRole("button", { name: choice }));
      if (choice === "Login") {
        await screen.findByRole("form", { name: "Sign in to Trace" });
      } else {
        await screen.findByRole("heading", { name: "Sign up" });
      }
      arrowHarness.updatePointer.mockClear();

      const field = document.querySelector<HTMLElement>(".onboarding");
      expect(field).not.toBeNull();
      fireEvent.pointerMove(field!, {
        pointerType: "mouse",
        clientX: 400,
        clientY: 300,
      });

      expect(arrowHarness.updatePointer).not.toHaveBeenCalled();
    },
  );

  it.each(["Back", "Escape"])(
    "clears the password and error, retains email, and restores Login focus on %s",
    async (exitMethod) => {
      accountApi.signIn.mockRejectedValue(new TraceAccountError(
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      ));
      const { user, email, password, submit } = await openLogin();
      arrowHarness.clearPointer.mockClear();

      await user.type(email, "sameer@example.com");
      await user.type(password, "private password");
      await user.click(submit);
      expect(await screen.findByRole("alert")).toBeTruthy();

      if (exitMethod === "Back") {
        await user.click(screen.getByRole("button", { name: "Back" }));
      } else {
        fireEvent.keyDown(window, { key: "Escape" });
      }

      const login = await screen.findByRole("button", { name: "Login" });
      expect(document.activeElement).toBe(login);
      expect(arrowHarness.clearPointer).toHaveBeenCalled();

      await user.click(login);
      const form = await screen.findByRole("form", { name: "Sign in to Trace" });
      expect((within(form).getByLabelText("Email") as HTMLInputElement).value)
        .toBe("sameer@example.com");
      expect((within(form).getByLabelText("Password") as HTMLInputElement).value)
        .toBe("");
      expect(within(form).queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(within(form).getByLabelText("Password"));
    },
  );

  it("clears the password, retains the email, and restores Login focus on Back", async () => {
    const { user, email, password } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "private password");

    await user.click(screen.getByRole("button", { name: "Back" }));
    const login = await screen.findByRole("button", { name: "Login" });
    expect(document.activeElement).toBe(login);

    await user.click(login);
    const form = await screen.findByRole("form", { name: "Sign in to Trace" });
    expect((within(form).getByLabelText("Email") as HTMLInputElement).value)
      .toBe("sameer@example.com");
    expect((within(form).getByLabelText("Password") as HTMLInputElement).value)
      .toBe("");
    expect(document.activeElement).toBe(within(form).getByLabelText("Password"));
  });

  it("shows the deferred signup placeholder over the same background", async () => {
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    const background = screen.getByTestId("opening-background");

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    expect(await screen.findByRole("heading", { name: "Sign up" })).toBeTruthy();
    expect(screen.getByText("Sign up isn’t available yet.")).toBeTruthy();
    expect(screen.getByTestId("opening-background")).toBe(background);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it.each(["Back", "Escape"])(
    "returns from the signup placeholder with %s and restores Login focus",
    async (exitMethod) => {
      const user = userEvent.setup();
      render(<Onboarding onContinueLocal={vi.fn()} />);
      await settleBootstrap();
      await user.click(screen.getByRole("button", { name: "Sign up" }));
      await screen.findByRole("heading", { name: "Sign up" });
      arrowHarness.clearPointer.mockClear();

      if (exitMethod === "Back") {
        await user.click(screen.getByRole("button", { name: "Back" }));
      } else {
        fireEvent.keyDown(window, { key: "Escape" });
      }

      const login = await screen.findByRole("button", { name: "Login" });
      expect(document.activeElement).toBe(login);
      expect(arrowHarness.clearPointer).toHaveBeenCalled();
    },
  );

  it("clears the password and preserves email when opening password reset", async () => {
    const { user, email, password } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "private password");
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));

    await screen.findByRole("heading", { name: "Reset your password" });
    expect((screen.getByLabelText("Email") as HTMLInputElement).value)
      .toBe("sameer@example.com");
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    const form = await screen.findByRole("form", { name: "Sign in to Trace" });
    expect((within(form).getByLabelText("Email") as HTMLInputElement).value)
      .toBe("sameer@example.com");
    expect((within(form).getByLabelText("Password") as HTMLInputElement).value)
      .toBe("");
  });
});

describe("sign in behavior", () => {
  it.each([
    ["unverified account", account({ emailVerified: false }), "Check your email"],
    ["verified owner without GitHub", account(), "Connect GitHub"],
    ["verified owner with GitHub", account({ githubLinked: true }), "Choose an installation"],
  ])("routes a %s to the existing onboarding destination", async (
    _label,
    signedInUser,
    destinationHeading,
  ) => {
    accountApi.signIn.mockResolvedValue({ user: signedInUser });
    const { user, email, password, submit } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "password-for-testing");
    await user.click(submit);

    expect(accountApi.signIn).toHaveBeenCalledTimes(1);
    expect(accountApi.signIn).toHaveBeenCalledWith({
      email: "sameer@example.com",
      password: "password-for-testing",
    });
    expect(await screen.findByRole("heading", { name: destinationHeading }))
      .toBeTruthy();
  });

  it("submits the login form with Enter from the password field", async () => {
    accountApi.signIn.mockResolvedValue({ user: account() });
    const { user, email, password } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "password-for-testing{Enter}");

    expect(accountApi.signIn).toHaveBeenCalledTimes(1);
    expect(accountApi.signIn).toHaveBeenCalledWith({
      email: "sameer@example.com",
      password: "password-for-testing",
    });
    expect(await screen.findByRole("heading", { name: "Connect GitHub" }))
      .toBeTruthy();
  });

  it("blocks a duplicate Enter submission while the first request is pending", async () => {
    const pending = deferred<{ user: ReturnType<typeof account> }>();
    accountApi.signIn.mockReturnValue(pending.promise);
    const { user, email, password, submit } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "password-for-testing{Enter}");

    await waitFor(() => expect(accountApi.signIn).toHaveBeenCalledTimes(1));
    expect(submit.disabled).toBe(true);
    await user.keyboard("{Enter}");
    expect(accountApi.signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ user: account() });
      await pending.promise;
    });
    expect(await screen.findByRole("heading", { name: "Connect GitHub" }))
      .toBeTruthy();
  });

  it("allows one pending request and blocks Back and Escape until it settles", async () => {
    const pending = deferred<{ user: ReturnType<typeof account> }>();
    accountApi.signIn.mockReturnValue(pending.promise);
    const { user, form, email, password, submit } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "password-for-testing");

    await user.dblClick(submit);
    expect(accountApi.signIn).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Signing in");
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("form", { name: "Sign in to Trace" })).toBe(form);

    await act(async () => {
      pending.resolve({ user: account() });
      await pending.promise;
    });
    expect(await screen.findByRole("heading", { name: "Connect GitHub" }))
      .toBeTruthy();
  });

  it("announces an authentication error and keeps the credentials editable", async () => {
    accountApi.signIn.mockRejectedValue(new TraceAccountError(
      "INVALID_CREDENTIALS",
      "Email or password is incorrect.",
    ));
    const { user, email, password, submit } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "wrong-password");
    await user.click(submit);

    expect((await screen.findByRole("alert")).textContent)
      .toContain("Email or password is incorrect.");
    expect(email.value).toBe("sameer@example.com");
    expect(password.value).toBe("wrong-password");
    expect(submit.disabled).toBe(false);
  });

  it.each(["email", "password"] as const)(
    "clears the authentication error when %s changes and permits a successful resubmit",
    async (editedField) => {
      accountApi.signIn
        .mockRejectedValueOnce(new TraceAccountError(
          "INVALID_CREDENTIALS",
          "Email or password is incorrect.",
        ))
        .mockResolvedValueOnce({ user: account() });
      const { user, email, password, submit } = await openLogin();
      await user.type(email, "sameer@example.com");
      await user.type(password, "wrong-password");
      await user.click(submit);
      expect(await screen.findByRole("alert")).toBeTruthy();

      if (editedField === "email") {
        await user.clear(email);
        await user.type(email, "retry@example.com");
      } else {
        await user.clear(password);
        await user.type(password, "corrected-password");
      }
      expect(screen.queryByRole("alert")).toBeNull();

      await user.click(submit);
      expect(accountApi.signIn).toHaveBeenCalledTimes(2);
      expect(accountApi.signIn).toHaveBeenLastCalledWith({
        email: editedField === "email"
          ? "retry@example.com"
          : "sameer@example.com",
        password: editedField === "password"
          ? "corrected-password"
          : "wrong-password",
      });
      expect(await screen.findByRole("heading", { name: "Connect GitHub" }))
        .toBeTruthy();
    },
  );

  it("preserves invitee intent through sign in", async () => {
    accountApi.pendingInvite.mockResolvedValue({ pending: true });
    accountApi.signIn.mockResolvedValue({ user: account() });
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);

    const form = await screen.findByRole("form", { name: "Sign in to Trace" });
    expect(screen.getByRole("status").textContent).toContain("invitation is ready");
    await user.type(within(form).getByLabelText("Email"), "sameer@example.com");
    await user.type(within(form).getByLabelText("Password"), "password-for-testing");
    await user.click(within(form).getByRole("button", { name: "Login" }));

    expect(await screen.findByRole("heading", { name: "Join a workspace" }))
      .toBeTruthy();
  });

  it("explains an unavailable account service and disables submission", async () => {
    accountApi.state.mockResolvedValue({
      availability: "not-configured",
      user: null,
      message: null,
    });
    const { submit } = await openLogin(false);
    expect(submit.disabled).toBe(true);
    expect(screen.getByRole("status").textContent)
      .toContain("not configured on this Mac");
  });
});
