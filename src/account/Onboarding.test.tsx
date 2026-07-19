// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import traceFrameUrl from "../../design/trace-frame.svg?url";
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
  signUp: vi.fn(),
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
    props: { readingField?: string },
    ref,
  ) {
    React.useImperativeHandle(ref, () => arrowHarness, []);
    return React.createElement("div", {
      "data-testid": "opening-background",
      "data-reading-field": props.readingField ?? "none",
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
    const animationKey = JSON.stringify(animate);
    React.useLayoutEffect(() => {
      onAnimationComplete?.();
    }, [animationKey]);
    return <div ref={ref} {...props} />;
  });

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv },
    useIsPresent: () => motionHarness.isPresent,
    useReducedMotion: () => motionHarness.reducedMotion,
  };
});

vi.mock("@outpacelabs/avatars", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    GradientAvatar: ({ seed, size }: { seed: string; size: number }) => (
      React.createElement("span", {
        "data-testid": "gradient-avatar",
        "data-seed": seed,
        style: { width: size, height: size },
      })
    ),
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

function latestOpeningMotion(className: string) {
  const render = motionHarness.renders.slice().reverse().find(
    (candidate) => candidate.className === className,
  );
  expect(render).toBeDefined();
  return render!;
}

describe("opening account views", () => {
  it("uses the canonical brandbook Frame in a decorative inline lockup", async () => {
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    const choiceStage = document.querySelector<HTMLElement>(
      ".onboarding-opening-choice-stage",
    );
    const lockup = document.querySelector<HTMLElement>(
      ".onboarding-opening-lockup",
    );
    const mark = lockup?.querySelector<HTMLImageElement>(
      ".onboarding-opening-lockup__mark",
    );

    expect(choiceStage).not.toBeNull();
    expect(lockup).not.toBeNull();
    expect(choiceStage?.contains(lockup)).toBe(true);
    expect(document.querySelectorAll(".onboarding-opening-lockup__mark")).toHaveLength(1);
    expect(mark?.getAttribute("src")).toBe(traceFrameUrl);
    expect(mark?.getAttribute("alt")).toBe("");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.getAttribute("draggable")).toBe("false");
    expect(mark?.getAttribute("width")).toBe("25");
    expect(mark?.getAttribute("height")).toBe("25");
    expect(mark?.hasAttribute("tabindex")).toBe(false);
    expect(mark?.closest("a, button")).toBeNull();
    expect(lockup?.textContent).toBe("Trace");
    expect(screen.queryByRole("img")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Login" }));
    await screen.findByRole("form", { name: "Sign in to Trace" });
    expect(document.querySelector(".onboarding-opening-lockup__mark")).toBe(mark);
    expect(choiceStage?.getAttribute("aria-hidden")).toBe("true");
    expect(choiceStage?.hasAttribute("inert")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Login" })).not.toBeNull();
    expect(document.querySelector(".onboarding-opening-lockup__mark")).toBe(mark);
  });

  it("keeps one background instance while replacing choices with the login form", async () => {
    const { background, email } = await openLogin();
    expect(screen.getByTestId("opening-background")).toBe(background);
    expect(screen.queryByRole("group", { name: "Account access" })).toBeNull();
    expect(document.activeElement).toBe(email);
  });

  it("keeps Back mounted but inert and hidden while the choice stage is active", async () => {
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    const scene = document.querySelector<HTMLElement>(".onboarding-opening-scene");
    const backStage = document.querySelector<HTMLElement>(".onboarding-opening-back-stage");
    const back = document.querySelector<HTMLButtonElement>(".onboarding-opening-back");

    expect(scene?.style.getPropertyValue("--opening-scene-duration")).toBe("240ms");
    expect(backStage?.dataset.active).toBe("false");
    expect(backStage?.getAttribute("aria-hidden")).toBe("true");
    expect(backStage?.hasAttribute("inert")).toBe(true);
    expect(back?.disabled).toBe(true);
    expect(back?.tabIndex).toBe(-1);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
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

  it("stages choice exit before the login form and Back control enter", async () => {
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    await userEvent.setup().click(screen.getByRole("button", { name: "Login" }));

    expect(latestOpeningMotion("onboarding-opening-choice-stage")).toMatchObject({
      initial: false,
      animate: { opacity: 0 },
      transition: { duration: 0.096, ease: "easeOut" },
    });
    expect(latestOpeningMotion("onboarding-opening-form-stage")).toMatchObject({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { delay: 0.072, duration: 0.168, ease: "easeOut" },
    });
    expect(latestOpeningMotion("onboarding-opening-back-stage")).toMatchObject({
      initial: false,
      animate: { opacity: 1 },
      transition: { delay: 0.072, duration: 0.168, ease: "easeOut" },
    });
  });

  it("makes a non-present form stage inert and hidden during its exit", async () => {
    motionHarness.isPresent = false;
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    await userEvent.setup().click(screen.getByRole("button", { name: "Login" }));

    const openingView = document.querySelector<HTMLElement>(
      ".onboarding-opening-form-stage",
    );
    expect(openingView?.dataset.present).toBe("false");
    expect(openingView?.getAttribute("aria-hidden")).toBe("true");
    expect(openingView?.hasAttribute("inert")).toBe(true);
    expect(latestOpeningMotion("onboarding-opening-form-stage").transition).toEqual({
      duration: 0.096,
      ease: "easeOut",
    });
  });

  it("applies final opening-stage states immediately for reduced motion", async () => {
    motionHarness.reducedMotion = true;
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    await userEvent.setup().click(screen.getByRole("button", { name: "Login" }));

    expect(latestOpeningMotion("onboarding-opening-choice-stage").transition)
      .toEqual({ duration: 0 });
    expect(latestOpeningMotion("onboarding-opening-form-stage").transition)
      .toEqual({ duration: 0 });
    expect(latestOpeningMotion("onboarding-opening-back-stage").transition)
      .toEqual({ duration: 0 });
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
        await screen.findByRole("heading", { name: "Set up your profile" });
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

  it("shows the real signup wizard over the same background", async () => {
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    const background = screen.getByTestId("opening-background");

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    const form = await screen.findByRole("form", { name: "Set up your profile" });
    expect(within(form).getByLabelText("First name")).toBeTruthy();
    expect(within(form).getByLabelText("Last name")).toBeTruthy();
    expect(within(form).getAllByRole("radio", { name: /^Avatar / })).toHaveLength(12);
    expect(within(form).getByRole("button", { name: "Next →" })).toBeTruthy();
    expect(screen.getByTestId("opening-background")).toBe(background);
  });

  it("uses compact for login and expanded reading fields through signup verification", async () => {
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    const background = screen.getByTestId("opening-background");
    expect(background.getAttribute("data-reading-field")).toBe("none");

    await user.click(screen.getByRole("button", { name: "Login" }));
    await screen.findByRole("form", { name: "Sign in to Trace" });
    expect(background.getAttribute("data-reading-field")).toBe("compact");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await screen.findByRole("form", { name: "Set up your profile" });
    expect(background.getAttribute("data-reading-field")).toBe("expanded");

    await user.type(screen.getByLabelText("First name"), "Sameer");
    await user.type(screen.getByLabelText("Last name"), "Patel");
    await user.click(screen.getByRole("button", { name: "Next →" }));
    await user.type(screen.getByLabelText("Email"), "sameer@example.com");
    await user.click(screen.getByRole("button", { name: "Next →" }));
    await user.type(screen.getByLabelText("Password"), "password-for-testing");
    await user.type(screen.getByLabelText("Confirm password"), "password-for-testing");
    await user.click(screen.getByRole("button", { name: "Next →" }));
    accountApi.signUp.mockResolvedValue({ accepted: true });
    await user.click(screen.getByRole("button", { name: "Create account →" }));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(background.getAttribute("data-reading-field")).toBe("expanded");
  });

  it.each(["Back", "Escape"])(
    "returns from signup with %s and restores Login focus",
    async (exitMethod) => {
      const user = userEvent.setup();
      render(<Onboarding onContinueLocal={vi.fn()} />);
      await settleBootstrap();
      await user.click(screen.getByRole("button", { name: "Sign up" }));
      await screen.findByRole("heading", { name: "Set up your profile" });
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

  it("submits a whitespace-normalized signup payload and keeps verification on the opening canvas", async () => {
    accountApi.signUp.mockResolvedValue({ accepted: true });
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();
    const background = screen.getByTestId("opening-background");

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    let form = await screen.findByRole("form", { name: "Set up your profile" });
    await user.type(within(form).getByLabelText("First name"), "  Sameer  ");
    await user.type(within(form).getByLabelText("Last name"), "  Patel  ");
    await user.click(within(form).getByRole("button", { name: "Next →" }));

    form = await screen.findByRole("form", { name: "Where should we send your link?" });
    await user.type(within(form).getByLabelText("Email"), "  sameer@example.com  ");
    await user.click(within(form).getByRole("button", { name: "Next →" }));

    form = await screen.findByRole("form", { name: "Create a password" });
    await user.type(within(form).getByLabelText("Password"), "password-for-testing");
    await user.type(within(form).getByLabelText("Confirm password"), "password-for-testing");
    await user.click(within(form).getByRole("button", { name: "Next →" }));

    form = await screen.findByRole("form", { name: "Set up your editor" });
    await user.click(within(form).getByRole("radio", { name: /^Dark/ }));
    await user.click(within(form).getByRole("radio", { name: "Violet" }));
    await user.click(within(form).getByRole("button", { name: "Create account →" }));

    await waitFor(() => expect(accountApi.signUp).toHaveBeenCalledTimes(1));
    expect(accountApi.signUp).toHaveBeenCalledWith({
      displayName: "Sameer Patel",
      email: "sameer@example.com",
      password: "password-for-testing",
    });
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(screen.getByText("sameer@example.com")).toBeTruthy();
    expect(screen.queryByDisplayValue("password-for-testing")).toBeNull();
    expect(screen.getByTestId("opening-background")).toBe(background);
    expect(screen.queryByText("Sign up isn’t available yet.")).toBeNull();
  });

  it("allows one pending signup request and ignores duplicate, Back, and Escape events", async () => {
    const pending = deferred<{ accepted: true }>();
    accountApi.signUp.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    let form = await screen.findByRole("form", { name: "Set up your profile" });
    await user.type(within(form).getByLabelText("First name"), "Sameer");
    await user.type(within(form).getByLabelText("Last name"), "Patel");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Where should we send your link?" });
    await user.type(within(form).getByLabelText("Email"), "sameer@example.com");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Create a password" });
    await user.type(within(form).getByLabelText("Password"), "password-for-testing");
    await user.type(within(form).getByLabelText("Confirm password"), "password-for-testing");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Set up your editor" });
    const topBack = screen.getByRole("button", { name: "Back" });

    // Keep all events in one React batch: the pending ref must protect the
    // opening screen before the state update that renders `busy` commits.
    act(() => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      topBack.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    await waitFor(() => expect(accountApi.signUp).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("form", { name: "Set up your editor" })).toBe(form);
    expect((screen.getByRole("button", { name: "Creating account…" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "← Back" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled)
      .toBe(true);

    await act(async () => {
      pending.resolve({ accepted: true });
      await pending.promise;
    });
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
  });

  it("keeps a failed signup editable and preserves it for correction and retry", async () => {
    accountApi.signUp
      .mockRejectedValueOnce(new TraceAccountError(
        "EMAIL_ALREADY_EXISTS",
        "An account already uses that email.",
      ))
      .mockResolvedValueOnce({ accepted: true });
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    let form = await screen.findByRole("form", { name: "Set up your profile" });
    await user.type(within(form).getByLabelText("First name"), "Sameer");
    await user.type(within(form).getByLabelText("Last name"), "Patel");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Where should we send your link?" });
    await user.type(within(form).getByLabelText("Email"), "sameer@example.com");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Create a password" });
    await user.type(within(form).getByLabelText("Password"), "password-for-testing");
    await user.type(within(form).getByLabelText("Confirm password"), "password-for-testing");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Set up your editor" });
    await user.click(within(form).getByRole("button", { name: "Create account →" }));

    expect((await screen.findByRole("alert")).textContent)
      .toContain("An account already uses that email.");
    expect((screen.getByRole("button", { name: "Create account →" }) as HTMLButtonElement).disabled)
      .toBe(false);

    await user.click(screen.getByRole("button", { name: "← Back" }));
    form = await screen.findByRole("form", { name: "Create a password" });
    const password = within(form).getByLabelText("Password") as HTMLInputElement;
    const confirmation = within(form).getByLabelText("Confirm password") as HTMLInputElement;
    expect(password.value).toBe("password-for-testing");
    expect(confirmation.value).toBe("password-for-testing");
    expect(password.disabled).toBe(false);
    expect(confirmation.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();

    await user.clear(password);
    await user.type(password, "corrected-password");
    await user.clear(confirmation);
    await user.type(confirmation, "corrected-password");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Set up your editor" });
    await user.click(within(form).getByRole("button", { name: "Create account →" }));

    await waitFor(() => expect(accountApi.signUp).toHaveBeenCalledTimes(2));
    expect(accountApi.signUp).toHaveBeenNthCalledWith(1, {
      displayName: "Sameer Patel",
      email: "sameer@example.com",
      password: "password-for-testing",
    });
    expect(accountApi.signUp).toHaveBeenNthCalledWith(2, {
      displayName: "Sameer Patel",
      email: "sameer@example.com",
      password: "corrected-password",
    });
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
  });

  it("retains signup identity and appearance but clears secrets and errors on a global exit", async () => {
    accountApi.signUp.mockRejectedValue(new TraceAccountError(
      "EMAIL_ALREADY_EXISTS",
      "An account already uses that email.",
    ));
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    let form = await screen.findByRole("form", { name: "Set up your profile" });
    await user.type(within(form).getByLabelText("First name"), "Ada");
    await user.type(within(form).getByLabelText("Last name"), "Lovelace");
    await user.click(within(form).getByRole("radio", { name: "Avatar 12" }));
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Where should we send your link?" });
    await user.type(within(form).getByLabelText("Email"), "ada@example.com");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Create a password" });
    await user.type(within(form).getByLabelText("Password"), "password-for-testing");
    await user.type(within(form).getByLabelText("Confirm password"), "password-for-testing");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Set up your editor" });
    await user.click(within(form).getByRole("radio", { name: /^Dark/ }));
    await user.click(within(form).getByRole("radio", { name: "Violet" }));
    await user.click(within(form).getByRole("radio", { name: "Large code" }));
    await user.click(within(form).getByRole("button", { name: "Create account →" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));
    const login = await screen.findByRole("button", { name: "Login" });
    expect(document.activeElement).toBe(login);
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    form = await screen.findByRole("form", { name: "Set up your profile" });
    expect((within(form).getByLabelText("First name") as HTMLInputElement).value).toBe("Ada");
    expect((within(form).getByLabelText("Last name") as HTMLInputElement).value).toBe("Lovelace");
    expect((within(form).getByRole("radio", { name: "Avatar 12" }) as HTMLInputElement).checked)
      .toBe(true);
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Where should we send your link?" });
    expect((within(form).getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Create a password" });
    const password = within(form).getByLabelText("Password") as HTMLInputElement;
    const confirmation = within(form).getByLabelText("Confirm password") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(confirmation.value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();

    await user.type(password, "new-password-for-ada");
    await user.type(confirmation, "new-password-for-ada");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Set up your editor" });
    expect((within(form).getByRole("radio", { name: /^Dark/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByRole("radio", { name: "Violet" }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByRole("radio", { name: "Large code" }) as HTMLInputElement).checked).toBe(true);
    expect(within(form).getByTestId("gradient-avatar").getAttribute("data-seed"))
      .toBe("trace-avatar:11");
  });

  it("supports resend and return to sign in from opening verification", async () => {
    accountApi.signUp.mockResolvedValue({ accepted: true });
    accountApi.resendVerification.mockResolvedValue({ accepted: true });
    const user = userEvent.setup();
    render(<Onboarding onContinueLocal={vi.fn()} />);
    await settleBootstrap();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    let form = await screen.findByRole("form", { name: "Set up your profile" });
    await user.type(within(form).getByLabelText("First name"), "Sameer");
    await user.type(within(form).getByLabelText("Last name"), "Patel");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Where should we send your link?" });
    await user.type(within(form).getByLabelText("Email"), "sameer@example.com");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Create a password" });
    await user.type(within(form).getByLabelText("Password"), "password-for-testing");
    await user.type(within(form).getByLabelText("Confirm password"), "password-for-testing");
    await user.click(within(form).getByRole("button", { name: "Next →" }));
    form = await screen.findByRole("form", { name: "Set up your editor" });
    await user.click(within(form).getByRole("button", { name: "Create account →" }));
    await screen.findByRole("heading", { name: "Check your email" });

    await user.click(screen.getByRole("button", { name: "Resend verification email" }));
    expect(accountApi.resendVerification).toHaveBeenCalledWith({ email: "sameer@example.com" });
    expect((await screen.findByRole("status")).textContent)
      .toContain("new verification email");

    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    const login = await screen.findByRole("form", { name: "Sign in to Trace" });
    expect((within(login).getByLabelText("Email") as HTMLInputElement).value)
      .toBe("sameer@example.com");
  });

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

  it("refreshes verification from the opening canvas into the next account step", async () => {
    accountApi.signIn.mockResolvedValue({ user: account({ emailVerified: false }) });
    accountApi.refreshState.mockResolvedValue({ user: account() });
    const { user, email, password, submit } = await openLogin();
    await user.type(email, "sameer@example.com");
    await user.type(password, "password-for-testing");
    await user.click(submit);

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "I verified my email" }));
    expect(accountApi.refreshState).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "Connect GitHub" })).toBeTruthy();
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
