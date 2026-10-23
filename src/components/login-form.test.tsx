import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The challenge and login routes are stubbed through global fetch and the
// Freighter extension through a module mock, so no real auth infrastructure,
// wallet, or network is touched.

const freighter = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  isConnected: vi.fn(),
  signMessage: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => freighter);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("lucide-react", () => ({
  ExternalLink: () => null,
  Loader2: () => null,
  Wallet: () => null,
}));

// Index-addressed hook storage, same approach as the other component tests.
let stateIndex = 0;
let refIndex = 0;
const states: unknown[] = [];
const setters: Array<(value: unknown) => void> = [];
const refs: Array<{ current: unknown }> = [];

vi.mock("react", async () => {
  const original = await vi.importActual<typeof import("react")>("react");
  return {
    ...original,
    useState: (initialValue: unknown) => {
      const index = stateIndex;
      stateIndex += 1;
      if (states.length <= index) {
        states.push(
          typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue
        );
        setters.push((next: unknown) => {
          states[index] =
            typeof next === "function" ? (next as (prev: unknown) => unknown)(states[index]) : next;
        });
      }
      return [states[index], setters[index]];
    },
    useRef: (initialValue: unknown) => {
      const index = refIndex;
      refIndex += 1;
      if (refs.length <= index) {
        refs.push({ current: initialValue });
      }
      return refs[index];
    },
    useEffect: () => {},
  };
});

import { AlertDescription } from "@/components/ui/alert";
import { LoginForm } from "./login-form";
import {
  loginWithFreighter,
  type LoginChallenge,
  type LoginChallengeSlot,
} from "@/lib/auth/freighter";

const WALLET = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

type LoginReply = { status: number; body: Record<string, unknown> };

const routes = {
  challengeCount: 0,
  challengeTtlMs: 300_000,
  loginBodies: [] as Array<{ publicKey: string; challengeId: string; signature: string }>,
  loginReplies: [] as LoginReply[],
};

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

function stubAuthRoutes(url: string, init?: RequestInit) {
  if (url === "/api/auth/challenge") {
    routes.challengeCount += 1;
    const challengeId = `00000000-0000-4000-8000-00000000000${routes.challengeCount}`;
    return jsonResponse(200, {
      challengeId,
      message: `Fortexa wallet login\nChallenge: ${challengeId}\nWallet: ${WALLET}`,
      publicKey: WALLET,
      expiresAt: new Date(Date.now() + routes.challengeTtlMs).toISOString(),
    });
  }
  if (url === "/api/auth/login") {
    routes.loginBodies.push(JSON.parse(String(init?.body)));
    const reply = routes.loginReplies.shift() ?? {
      status: 200,
      body: { ok: true, role: "operator", wallet: WALLET },
    };
    return jsonResponse(reply.status, reply.body);
  }
  return Promise.reject(new Error(`Unexpected fetch: ${url}`));
}

const fetchMock = vi.fn(stubAuthRoutes);

const locationAssign = vi.fn();

// Signature is derived from the challenge text, so a reused challenge would
// show up as a reused signature in the recorded login bodies.
function signatureFor(message: string) {
  return Buffer.from(`SIGNED_PAYLOAD:${message}`).toString("base64");
}

type Element = { type: unknown; props: Record<string, unknown> };

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "props" in node && "type" in node;
}

function walk(node: unknown, visit: (element: Element) => void) {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isElement(node)) {
    return;
  }
  visit(node);
  walk(node.props.children, visit);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  return isElement(node) ? textOf(node.props.children) : "";
}

function render() {
  stateIndex = 0;
  refIndex = 0;
  return LoginForm();
}

function renderReady() {
  render();
  // Hook order: loading, loginStep, checkingSession, error, successWallet.
  setters[2](false);
  return render();
}

function clickSignIn() {
  let onClick: (() => Promise<void>) | undefined;
  walk(renderReady(), (element) => {
    if (typeof element.props.onClick === "function") {
      onClick = element.props.onClick as () => Promise<void>;
    }
  });
  if (!onClick) {
    throw new Error("Sign-in button not rendered");
  }
  return onClick();
}

function visibleError() {
  let text: string | null = null;
  walk(render(), (element) => {
    if (element.type === AlertDescription) {
      text = textOf(element.props.children);
    }
  });
  return text;
}

function heldChallenge() {
  // Ref order: challengeRef, signInInFlightRef.
  return refs[0]?.current as LoginChallenge | null;
}

describe("LoginForm single-use challenge handling", () => {
  beforeEach(() => {
    states.length = 0;
    setters.length = 0;
    refs.length = 0;
    routes.challengeCount = 0;
    routes.challengeTtlMs = 300_000;
    routes.loginBodies = [];
    routes.loginReplies = [];
    fetchMock.mockReset().mockImplementation(stubAuthRoutes);
    locationAssign.mockClear();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { assign: locationAssign } });

    freighter.requestAccess.mockReset().mockResolvedValue({ address: WALLET });
    freighter.isConnected.mockReset().mockResolvedValue({ isConnected: true });
    freighter.signMessage.mockReset().mockImplementation(async (message: string) => ({
      signedMessage: signatureFor(message),
      signerAddress: WALLET,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function challengeRequests() {
    return fetchMock.mock.calls.filter(([url]) => url === "/api/auth/challenge").length;
  }

  it("fetches the challenge immediately before signing and holds it only during the attempt", async () => {
    const order: string[] = [];
    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      order.push(url);
      return stubAuthRoutes(url, init);
    });
    freighter.requestAccess.mockImplementationOnce(async () => {
      order.push("connect");
      return { address: WALLET };
    });
    freighter.signMessage.mockImplementationOnce(async (message: string) => {
      order.push("sign");
      expect(heldChallenge()?.message).toBe(message);
      return { signedMessage: signatureFor(message), signerAddress: WALLET };
    });

    expect(challengeRequests()).toBe(0);
    await clickSignIn();

    expect(order).toEqual(["connect", "/api/auth/challenge", "sign"]);
    expect(heldChallenge()).toBeNull();
  });

  it("clears the challenge after a failed login and fetches a new one on the next click", async () => {
    routes.loginReplies.push({
      status: 401,
      body: { error: "Wallet signature verification failed.", code: "invalid_signature" },
    });

    await clickSignIn();

    expect(heldChallenge()).toBeNull();
    expect(routes.loginBodies).toHaveLength(1);
    expect(visibleError()).toContain("invalid_signature");

    await clickSignIn();

    expect(challengeRequests()).toBe(2);
    expect(routes.loginBodies).toHaveLength(2);
    const [first, second] = routes.loginBodies;
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(second.signature).not.toBe(first.signature);
    expect(heldChallenge()).toBeNull();
    expect(locationAssign).toHaveBeenCalledWith("/dashboard");
  });

  it("clears the challenge after a successful login", async () => {
    await clickSignIn();

    expect(routes.loginBodies).toHaveLength(1);
    expect(heldChallenge()).toBeNull();
    expect(locationAssign).toHaveBeenCalledWith("/dashboard");
  });

  it("drops a challenge that expired while the wallet prompt was open and refreshes it on the next click", async () => {
    routes.challengeTtlMs = 30_000;
    freighter.signMessage.mockImplementationOnce(async (message: string) => {
      vi.setSystemTime(Date.now() + 30_000);
      return { signedMessage: signatureFor(message), signerAddress: WALLET };
    });

    await clickSignIn();

    expect(routes.loginBodies).toHaveLength(0);
    expect(heldChallenge()).toBeNull();
    expect(visibleError()).toContain("(code: expired)");

    await clickSignIn();

    expect(challengeRequests()).toBe(2);
    expect(routes.loginBodies).toHaveLength(1);
    expect(routes.loginBodies[0].challengeId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("shows the API error code without the signed payload", async () => {
    routes.loginReplies.push({
      status: 400,
      body: {
        error: "Login challenge was already used. Request a new challenge and sign again.",
        code: "replayed",
      },
    });

    await clickSignIn();

    const [{ signature }] = routes.loginBodies;
    const error = visibleError();
    expect(error).toContain("(code: replayed)");
    expect(error).not.toContain(signature);
    expect(error).not.toContain("Fortexa wallet login");
  });

  it("replaces an API error message that echoes the signed payload but keeps its code", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/login") {
        const body = JSON.parse(String(init?.body)) as { signature: string };
        routes.loginBodies.push(body as never);
        return jsonResponse(401, {
          error: `Bad signature ${body.signature}`,
          code: "invalid_signature",
        });
      }
      return jsonResponse(200, {
        challengeId: "00000000-0000-4000-8000-000000000009",
        message: "Fortexa wallet login\nChallenge: 00000000-0000-4000-8000-000000000009",
        publicKey: WALLET,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    });

    await clickSignIn();

    const [{ signature }] = routes.loginBodies;
    const error = visibleError();
    expect(error).toBe("Sign in failed. (code: invalid_signature)");
    expect(error).not.toContain(signature);
  });

  it("ignores a second click while the first attempt is in flight", async () => {
    routes.loginReplies.push({
      status: 401,
      body: { error: "Wallet signature verification failed.", code: "invalid_signature" },
    });

    // Hold the first attempt at the wallet prompt, then click again.
    let approveWallet!: () => void;
    freighter.requestAccess.mockImplementationOnce(
      () => new Promise((resolve) => (approveWallet = () => resolve({ address: WALLET })))
    );

    const first = clickSignIn();
    await vi.waitFor(() => expect(freighter.requestAccess).toHaveBeenCalledTimes(1));
    const second = clickSignIn();
    approveWallet();
    await Promise.all([first, second]);

    expect(freighter.requestAccess).toHaveBeenCalledTimes(1);

    expect(challengeRequests()).toBe(1);
    expect(routes.loginBodies).toHaveLength(1);

    // Once the attempt settles, a new click signs a new challenge.
    await clickSignIn();
    expect(challengeRequests()).toBe(2);
    expect(routes.loginBodies).toHaveLength(2);
    expect(routes.loginBodies[1].signature).not.toBe(routes.loginBodies[0].signature);
  });
});

describe("loginWithFreighter challenge slot", () => {
  const stale: LoginChallenge = {
    challengeId: "00000000-0000-4000-8000-0000000000ff",
    message: "stale challenge",
    publicKey: WALLET,
    expiresAtMs: NOW + 300_000,
  };

  beforeEach(() => {
    routes.challengeCount = 0;
    routes.challengeTtlMs = 300_000;
    routes.loginBodies = [];
    routes.loginReplies = [];
    fetchMock.mockReset().mockImplementation(stubAuthRoutes);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", fetchMock);
    freighter.requestAccess.mockReset().mockResolvedValue({ address: WALLET });
    freighter.isConnected.mockReset().mockResolvedValue({ isConnected: true });
    freighter.signMessage.mockReset().mockImplementation(async (message: string) => ({
      signedMessage: signatureFor(message),
      signerAddress: WALLET,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never submits a challenge left in the slot by an earlier attempt", async () => {
    const slot: LoginChallengeSlot = { current: stale };

    const result = await loginWithFreighter({ challengeSlot: slot });

    expect(result.ok).toBe(true);
    expect(routes.loginBodies[0].challengeId).not.toBe(stale.challengeId);
    expect(slot.current).toBeNull();
  });

  it("clears the slot and reports a code when the login route is unreachable", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/login") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return jsonResponse(200, {
        challengeId: "00000000-0000-4000-8000-000000000001",
        message: "Fortexa wallet login",
        publicKey: WALLET,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        init,
      });
    });
    const slot: LoginChallengeSlot = { current: null };

    const result = await loginWithFreighter({ challengeSlot: slot });

    expect(result).toMatchObject({ ok: false, code: "network_error" });
    expect(slot.current).toBeNull();
  });

  it("reports the challenge route's status as the code when it fails", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse(429, { error: "Too many challenge requests. Try again later." })
    );
    const slot: LoginChallengeSlot = { current: null };

    const result = await loginWithFreighter({ challengeSlot: slot });

    expect(result).toMatchObject({ ok: false, code: "challenge_http_429" });
    expect(freighter.signMessage).not.toHaveBeenCalled();
    expect(slot.current).toBeNull();
  });
});
