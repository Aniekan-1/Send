// Client for the Python relayer (dollardrop/relayer/app.py).
import type { Address, Hex } from "viem";
import { config } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(config.relayerUrl + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "Can't reach the Dollar Drop service. Check your connection and try again.");
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = typeof body.detail === "string" ? body.detail : `request failed (${resp.status})`;
    throw new ApiError(resp.status, detail);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export type DropStatus = "none" | "active" | "claimed" | "refunded";

export interface DropInfo {
  claim_key: Address;
  campaign_id: number;
  status: DropStatus;
  amount: number;
  expires_at: number;
  fee_cap: number;
  paused: boolean;
  fee: number;
  receive: number;
  relayer: Address;
  chainId: number;
  contract: Address;
}

export interface Health {
  ok: boolean;
  relayer: Address;
  chainId: number;
  contract: Address;
  circle: boolean;
}

export interface ClaimResult {
  txHash: Hex;
  recipient: Address;
  amount: number;
  fee: number;
}

export const api = {
  health: () => request<Health>("/health"),
  drop: (claimKey: Address) => request<DropInfo>(`/drops/${claimKey}`),
  claim: (body: { claimKey: Address; recipient: Address; fee: number; signature: Hex }) =>
    post<ClaimResult>("/claims", body),

  circleSocialToken: (deviceId: string) =>
    post<{ deviceToken: string; deviceEncryptionKey: string }>("/circle/social-token", { deviceId }),
  circleEmailToken: (deviceId: string, email: string) =>
    post<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }>("/circle/email-token", {
      deviceId,
      email,
    }),
  circleWallet: (userToken: string) =>
    post<{ challengeId: string | null; address: Address | null }>("/circle/wallet", { userToken }),
  circleTransfer: (userToken: string, destinationAddress: Address, amount: string) =>
    post<{ challengeId: string }>("/circle/transfer", { userToken, destinationAddress, amount }),
};

// ------------------------------------------------------------------ dashboards

export interface Campaign {
  id: number;
  owner: Address;
  amount: number;
  expires_at: number;
  fee_cap: number;
  paused: boolean;
  expired: boolean;
  created_at: number;
  created_tx: Hex;
  drops: number;
  claimed: number;
  refunded: number;
  active: number;
  distributed: number;
  locked: number;
  last_claim_at: number | null;
}

export interface DropRow {
  claim_key: Address;
  status: "active" | "claimed" | "refunded";
  recipient: Address | null;
  received: number | null;
  fee: number | null;
  claimed_at: number | null;
  claim_tx: Hex | null;
  refunded_at: number | null;
}

export interface Totals {
  campaigns: number;
  drops: number;
  claimed: number;
  refunded: number;
  active: number;
  recipients: number;
  distributed: number;
  fees: number;
  locked: number;
}

export interface Overview {
  totals: Totals;
  claimsByDay: { date: string; claims: number; amount: number }[];
  campaigns: Campaign[];
  recentClaims: (DropRow & { campaign_id: number })[];
  relayer: { address: Address; balanceUsdc: number; lowBalance: boolean; claimCost: number };
  contract: Address;
  chainId: number;
  indexedBlock: number;
}

export const dashboardApi = {
  publicStats: () =>
    request<Pick<Totals, "campaigns" | "claimed" | "recipients" | "distributed"> & { indexedBlock: number }>("/stats/public"),
  organizerCampaigns: (owner: Address) =>
    request<{ campaigns: Campaign[]; indexedBlock: number }>(`/organizers/${owner}/campaigns`),
  campaign: (id: number) => request<Campaign & { drops_list: DropRow[]; indexedBlock: number }>(`/campaigns/${id}`),
  adminOverview: (token: string) =>
    request<Overview>("/admin/overview", { headers: { Authorization: `Bearer ${token}` } }),
};
