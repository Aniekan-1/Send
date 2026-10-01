// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DollarDrop
/// @notice Claim links for USDC on Arc.
///
/// An organizer funds a campaign of drops. Each drop is locked to a one-time "claim key":
/// a throwaway keypair whose private key exists only inside the link / QR code.
///
/// To claim, the link holder signs (recipient, relayer, fee) with the claim key. Because the
/// signature names the recipient, anyone who copies a pending claim can only ever pay that
/// same recipient — front-running gains nothing.
///
/// Whoever submits the claim (normally our relayer) is repaid `fee` in USDC out of the drop.
/// On Arc, gas itself is paid in USDC, so the relayer's cost and the drop are the same currency:
/// no price oracle, no paymaster, no second token for the recipient.
contract DollarDrop is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Largest drop allowed while the contract is unaudited (50 USDC, 6 decimals).
    uint256 public constant MAX_DROP_AMOUNT = 50e6;
    /// @notice Largest per-claim fee a campaign may allow (0.10 USDC).
    uint256 public constant MAX_FEE_CAP = 0.10e6;
    /// @notice Keeps createCampaign / addDrops / refund within a sane gas budget.
    uint256 public constant MAX_DROPS_PER_CALL = 200;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address recipient,address relayer,uint256 fee)");

    enum Status {
        None,
        Active,
        Claimed,
        Refunded
    }

    struct Campaign {
        address owner;
        uint64 amountPerDrop;
        uint64 expiresAt;
        uint64 feeCap;
        bool paused;
    }

    struct Drop {
        uint64 campaignId;
        Status status;
    }

    IERC20 public immutable usdc;

    uint64 public campaignCount;
    mapping(uint64 campaignId => Campaign) public campaigns;
    mapping(address claimKey => Drop) public drops;
    /// @notice One claim per wallet per campaign.
    mapping(uint64 campaignId => mapping(address recipient => bool)) public hasClaimed;

    event CampaignCreated(
        uint64 indexed campaignId,
        address indexed owner,
        uint256 amountPerDrop,
        uint256 expiresAt,
        uint256 feeCap
    );
    event DropsAdded(uint64 indexed campaignId, uint256 count);
    event Claimed(
        address indexed claimKey,
        uint64 indexed campaignId,
        address indexed recipient,
        address relayer,
        uint256 amount,
        uint256 fee
    );
    event Refunded(address indexed claimKey, uint64 indexed campaignId, uint256 amount);
    event PausedSet(uint64 indexed campaignId, bool paused);

    error InvalidAmount();
    error InvalidFeeCap();
    error InvalidExpiry();
    error InvalidDropCount();
    error InvalidClaimKey();
    error InvalidRecipient();
    error DropExists(address claimKey);
    error DropNotActive(address claimKey);
    error NotCampaignOwner();
    error CampaignPaused();
    error CampaignExpired();
    error FeeTooHigh();
    error WrongRelayer();
    error AlreadyClaimed();
    error BadSignature();

    constructor(IERC20 usdc_) EIP712("DollarDrop", "1") {
        usdc = usdc_;
    }

    // ---------------------------------------------------------------- organizer

    /// @notice Create a campaign and fund `claimKeys.length` drops of `amountPerDrop` each.
    /// @dev Caller must first `approve` this contract for amountPerDrop * claimKeys.length USDC.
    ///      Claim keys are generated in the organizer's browser; only their addresses come here.
    function createCampaign(
        uint64 amountPerDrop,
        uint64 expiresAt,
        uint64 feeCap,
        address[] calldata claimKeys
    ) external nonReentrant returns (uint64 campaignId) {
        if (amountPerDrop == 0 || amountPerDrop > MAX_DROP_AMOUNT) revert InvalidAmount();
        if (feeCap > MAX_FEE_CAP || feeCap >= amountPerDrop) revert InvalidFeeCap();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();

        campaignId = ++campaignCount;
        campaigns[campaignId] = Campaign({
            owner: msg.sender,
            amountPerDrop: amountPerDrop,
            expiresAt: expiresAt,
            feeCap: feeCap,
            paused: false
        });
        emit CampaignCreated(campaignId, msg.sender, amountPerDrop, expiresAt, feeCap);

        _addDrops(campaignId, amountPerDrop, claimKeys);
    }

    /// @notice Fund more drops in an existing, unexpired campaign.
    function addDrops(uint64 campaignId, address[] calldata claimKeys) external nonReentrant {
        Campaign storage c = campaigns[campaignId];
        if (c.owner != msg.sender) revert NotCampaignOwner();
        if (block.timestamp >= c.expiresAt) revert CampaignExpired();
        _addDrops(campaignId, c.amountPerDrop, claimKeys);
    }

    /// @notice Pause or resume claims for a campaign.
    function setPaused(uint64 campaignId, bool paused) external {
        Campaign storage c = campaigns[campaignId];
        if (c.owner != msg.sender) revert NotCampaignOwner();
        c.paused = paused;
        emit PausedSet(campaignId, paused);
    }

    /// @notice Return unclaimed drops to the campaign owner. Works at any time (cancel or after expiry).
    function refund(address[] calldata claimKeys) external nonReentrant {
        uint256 n = claimKeys.length;
        if (n == 0 || n > MAX_DROPS_PER_CALL) revert InvalidDropCount();

        uint256 total;
        for (uint256 i; i < n; ++i) {
            address key = claimKeys[i];
            Drop storage d = drops[key];
            if (d.status != Status.Active) revert DropNotActive(key);
            Campaign storage c = campaigns[d.campaignId];
            if (c.owner != msg.sender) revert NotCampaignOwner();

            d.status = Status.Refunded;
            total += c.amountPerDrop;
            emit Refunded(key, d.campaignId, c.amountPerDrop);
        }
        usdc.safeTransfer(msg.sender, total);
    }

    // ---------------------------------------------------------------- recipient

    /// @notice Claim a drop.
    /// @param claimKey  Address of the drop's one-time key (derived from the secret in the link).
    /// @param recipient Wallet that receives the money.
    /// @param relayer   Only this address may submit the claim; address(0) lets anyone submit.
    /// @param fee       USDC paid to msg.sender for submitting; at most the campaign's feeCap.
    /// @param signature EIP-712 signature of Claim(recipient, relayer, fee) by the claim key.
    function claim(
        address claimKey,
        address recipient,
        address relayer,
        uint256 fee,
        bytes calldata signature
    ) external nonReentrant {
        Drop storage d = drops[claimKey];
        if (d.status != Status.Active) revert DropNotActive(claimKey);
        uint64 campaignId = d.campaignId;
        Campaign storage c = campaigns[campaignId];

        if (c.paused) revert CampaignPaused();
        if (block.timestamp >= c.expiresAt) revert CampaignExpired();
        if (recipient == address(0)) revert InvalidRecipient();
        if (relayer != address(0) && relayer != msg.sender) revert WrongRelayer();
        if (fee > c.feeCap) revert FeeTooHigh();
        if (hasClaimed[campaignId][recipient]) revert AlreadyClaimed();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, recipient, relayer, fee)));
        if (ECDSA.recover(digest, signature) != claimKey) revert BadSignature();

        d.status = Status.Claimed;
        hasClaimed[campaignId][recipient] = true;

        uint256 amount = c.amountPerDrop;
        if (fee > 0) usdc.safeTransfer(msg.sender, fee);
        usdc.safeTransfer(recipient, amount - fee);

        emit Claimed(claimKey, campaignId, recipient, msg.sender, amount - fee, fee);
    }

    // ---------------------------------------------------------------- views

    /// @notice Everything the claim page needs to show a drop.
    function getDrop(address claimKey)
        external
        view
        returns (
            uint64 campaignId,
            Status status,
            uint256 amount,
            uint256 expiresAt,
            uint256 feeCap,
            bool paused
        )
    {
        Drop storage d = drops[claimKey];
        Campaign storage c = campaigns[d.campaignId];
        return (d.campaignId, d.status, c.amountPerDrop, c.expiresAt, c.feeCap, c.paused);
    }

    /// @notice EIP-712 digest the claim key must sign. Handy for off-chain checks and tests.
    function claimDigest(address recipient, address relayer, uint256 fee) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, recipient, relayer, fee)));
    }

    // ---------------------------------------------------------------- internal

    function _addDrops(uint64 campaignId, uint64 amountPerDrop, address[] calldata claimKeys) private {
        uint256 n = claimKeys.length;
        if (n == 0 || n > MAX_DROPS_PER_CALL) revert InvalidDropCount();

        for (uint256 i; i < n; ++i) {
            address key = claimKeys[i];
            if (key == address(0)) revert InvalidClaimKey();
            if (drops[key].status != Status.None) revert DropExists(key);
            drops[key] = Drop({campaignId: campaignId, status: Status.Active});
        }
        emit DropsAdded(campaignId, n);

        usdc.safeTransferFrom(msg.sender, address(this), uint256(amountPerDrop) * n);
    }
}
