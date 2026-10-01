# Dollar Drop

Hand out USDC with a QR code or a link. Recipients claim with nothing but a phone: no crypto, no app, no second token.

Built on [Arc](https://docs.arc.io), where gas is paid in USDC. That lets the relayer that submits a claim be repaid **in USDC, out of the drop itself**, with no price oracle and no paymaster.

> **Status:** early prototype, **unaudited**. Drops are capped at 50 USDC each.

## How it works

1. An organizer creates a campaign, e.g. 100 drops of 10 USDC. For each drop their browser generates a one-time *claim key*; only the key's address is sent to the contract.
2. Each drop becomes a link like `https://…/claim#k=<claim key secret>` (the secret sits after `#`, so it never reaches a server).
3. The recipient opens the link and signs in (Circle wallet). The page signs `Claim(recipient, relayer, fee)` with the claim key.
4. The relayer submits the claim; the contract checks the signature, pays the relayer `fee` and sends the rest to the recipient.

## Security model

| Risk | Protection |
| --- | --- |
| Copying a claim in progress (front-running) | Signature names the recipient; a copied claim can only pay that same recipient |
| Leaked links | Secrets are made client-side, live after `#`, work once, and the owner can refund unclaimed drops anytime |
| One person, many claims | One claim per wallet per campaign; owner can pause |
| Relayer overcharging | Fee is signed by the claimer and capped per campaign (max 0.10 USDC) |
| Contract bugs | Small, non-upgradeable, no admin; OpenZeppelin for signatures and transfers; 50 USDC per-drop cap |

Known limits: a person with several wallets can claim several drops from the same campaign.

## Layout

```
contracts/DollarDrop.sol   money box (Solidity + OpenZeppelin)
dollardrop/                Python package: compile, claim signing, Arc constants
tests/                     pytest suite against an in-memory EVM
scripts/                   deployment
```

## Development

Requires [uv](https://docs.astral.sh/uv/) and git.

```bash
git submodule update --init          # OpenZeppelin
uv sync                              # Python 3.12 env + deps
uv run python -m dollardrop.compile  # build/*.json
uv run pytest
```

## Arc mainnet

| | |
| --- | --- |
| Chain ID | 5042 |
| RPC | https://rpc.mainnet.arc.io |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
