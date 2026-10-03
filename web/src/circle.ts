// Google / email sign-in with Circle user-controlled wallets.
//
// We only need the user's Arc wallet *address* from Circle: the claim itself is signed by the
// link's claim key. The wallet's keys stay with the user; the Circle API key stays on our server.
//
// Google sign-in leaves the page and comes back, so the device tokens are kept in sessionStorage
// (this tab only) until the redirect returns.
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import type { Configs, LoginConfigs, SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";
import { type Address, getAddress } from "viem";
import { api } from "./api";
import { PENDING_GOOGLE, config } from "./config";

export interface Session {
  userToken: string;
  encryptionKey: string;
}

const SESSION = "dd:circle-session";

/** Keep the signed-in session for this tab only, so the claim page can hand over to My wallet. */
export function saveSession(session: Session) {
  sessionStorage.setItem(SESSION, JSON.stringify(session));
}
export function loadSession(): Session | null {
  const saved = sessionStorage.getItem(SESSION);
  return saved ? (JSON.parse(saved) as Session) : null;
}
export function clearSession() {
  sessionStorage.removeItem(SESSION);
}

/** Ask the user to approve a Circle challenge (wallet creation, a transfer) in Circle's own screen. */
function executeChallenge(session: Session, challengeId: string): Promise<void> {
  getSdk().setAuthentication(session);
  return new Promise((resolve, reject) =>
    getSdk().execute(challengeId, (error) => (error ? reject(new Error(error.message)) : resolve())),
  );
}

type DeviceTokens = Pick<LoginConfigs, "deviceToken" | "deviceEncryptionKey">;

let sdk: W3SSdk | undefined;

function getSdk(): W3SSdk {
  sdk ??= new W3SSdk({ appSettings: { appId: config.circleAppId } });
  return sdk;
}

function googleConfig(tokens: DeviceTokens): Configs {
  return {
    appSettings: { appId: config.circleAppId },
    loginConfigs: {
      ...tokens,
      google: {
        clientId: config.googleClientId,
        // Come back to the claim page without the "#k=" secret; it waits in sessionStorage.
        redirectUri: location.origin + location.pathname,
        selectAccountPrompt: true,
      },
    },
  };
}

function loginPromise(start: (done: (s: Session) => void, fail: (e: Error) => void) => void): Promise<Session> {
  return new Promise((resolve, reject) =>
    start(resolve, (e) => reject(e instanceof Error ? e : new Error(String(e)))),
  );
}

/** Starts Google sign-in. The page navigates away; call resumeGoogleLogin() when it loads again. */
export async function startGoogleLogin(): Promise<void> {
  const deviceId = await getSdk().getDeviceId();
  const tokens = await api.circleSocialToken(deviceId);
  sessionStorage.setItem(PENDING_GOOGLE, JSON.stringify(tokens));
  getSdk().updateConfigs(googleConfig(tokens));
  await getSdk().performLogin("Google" as SocialLoginProvider);
}

/** Finish a Google sign-in after the redirect back. Returns null when none is pending. */
export function resumeGoogleLogin(): Promise<Session> | null {
  const saved = sessionStorage.getItem(PENDING_GOOGLE);
  if (!saved) return null;
  sessionStorage.removeItem(PENDING_GOOGLE);
  const tokens = JSON.parse(saved) as DeviceTokens;

  return loginPromise((done, fail) => {
    getSdk().updateConfigs(googleConfig(tokens), (error, result) => {
      if (error || !result) fail(new Error(error?.message ?? "Google sign-in was cancelled"));
      else done({ userToken: result.userToken, encryptionKey: result.encryptionKey });
    });
  });
}

/** Emails a one-time code and opens Circle's code-entry screen. */
export async function emailLogin(email: string): Promise<Session> {
  const deviceId = await getSdk().getDeviceId();
  const { deviceToken, deviceEncryptionKey, otpToken } = await api.circleEmailToken(deviceId, email);

  return loginPromise((done, fail) => {
    getSdk().updateConfigs(
      { appSettings: { appId: config.circleAppId }, loginConfigs: { deviceToken, deviceEncryptionKey, otpToken } },
      (error, result) => {
        if (error || !result) fail(new Error(error?.message ?? "Email sign-in was cancelled"));
        else done({ userToken: result.userToken, encryptionKey: result.encryptionKey });
      },
    );
    getSdk().verifyOtp();
  });
}

/** The signed-in user's Arc wallet address, creating the wallet on first sign-in. */
export async function walletAddress(session: Session): Promise<Address> {
  let { challengeId, address } = await api.circleWallet(session.userToken);

  if (challengeId) {
    await executeChallenge(session, challengeId);
    // Wallet creation finishes shortly after the challenge; poll briefly.
    for (let i = 0; i < 10 && !address; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      ({ address } = await api.circleWallet(session.userToken));
    }
  }

  if (!address) throw new Error("Your wallet is still being created. Please try again in a moment.");
  return getAddress(address);
}

/** Send USDC from the signed-in user's wallet. The user approves it in Circle's screen. */
export async function sendUsdc(session: Session, to: Address, amount: string): Promise<void> {
  const { challengeId } = await api.circleTransfer(session.userToken, to, amount);
  await executeChallenge(session, challengeId);
}
