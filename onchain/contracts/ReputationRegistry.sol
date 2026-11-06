// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ReputationRegistry
/// @notice A trader's reputation score, written per wallet so any app or contract can read it directly.
/// @dev The issuer is whoever holds `relayer`. Readers decide whether they trust this contract's issuer.
contract ReputationRegistry {
    error NotRelayer();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ScoreOutOfRange();

    /// @notice The score and what it's made of. Basis points are hundredths of a percent.
    struct Attestation {
        uint16 score;
        uint16 winRateBps;
        int32 avgReturnBps;
        uint16 avgDrawdownBps;
        uint32 avgHoldSeconds;
        uint16 feeBps;
        uint32 closedPositions;
        uint64 attestedAt;
    }

    event ReputationAttested(
        address indexed wallet,
        uint16 score,
        uint16 winRateBps,
        int32 avgReturnBps,
        uint16 avgDrawdownBps,
        uint32 avgHoldSeconds,
        uint16 feeBps,
        uint32 closedPositions
    );
    event RelayerChanged(address indexed previousRelayer, address indexed newRelayer);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    mapping(address => Attestation) private _attestations;

    /// @notice Address authorized to write attestations.
    address public relayer;
    /// @notice Address authorized to manage the relayer and initiate ownership transfers.
    address public owner;
    /// @notice Address authorized to accept the pending ownership transfer.
    address public pendingOwner;

    constructor(address initialOwner, address initialRelayer) {
        if (initialOwner == address(0) || initialRelayer == address(0)) revert ZeroAddress();
        owner = initialOwner;
        relayer = initialRelayer;
        emit OwnershipTransferred(address(0), initialOwner);
        emit RelayerChanged(address(0), initialRelayer);
    }

    /// @notice Writes a wallet's current score, replacing the last one. The event log keeps the history.
    function attest(
        address wallet,
        uint16 score,
        uint16 winRateBps,
        int32 avgReturnBps,
        uint16 avgDrawdownBps,
        uint32 avgHoldSeconds,
        uint16 feeBps,
        uint32 closedPositions
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (wallet == address(0)) revert ZeroAddress();
        if (score > 100) revert ScoreOutOfRange();

        _attestations[wallet] = Attestation(score, winRateBps, avgReturnBps, avgDrawdownBps, avgHoldSeconds, feeBps, closedPositions, uint64(block.timestamp));
        emit ReputationAttested(wallet, score, winRateBps, avgReturnBps, avgDrawdownBps, avgHoldSeconds, feeBps, closedPositions);
    }

    /// @notice The one call most apps need: a wallet's score out of 100, and when it was written.
    /// @dev attestedAt is zero for a wallet with no score yet.
    function scoreOf(address wallet) external view returns (uint16 score, uint64 attestedAt) {
        Attestation storage a = _attestations[wallet];
        return (a.score, a.attestedAt);
    }

    /// @notice The full record behind a wallet's score.
    function attestationOf(address wallet) external view returns (Attestation memory) {
        return _attestations[wallet];
    }

    /// @notice Replaces the relayer with a nonzero address. Only callable by the owner.
    function setRelayer(address newRelayer) external {
        if (msg.sender != owner) revert NotOwner();
        if (newRelayer == address(0)) revert ZeroAddress();
        address previousRelayer = relayer;
        relayer = newRelayer;
        emit RelayerChanged(previousRelayer, newRelayer);
    }

    /// @notice Starts or replaces a pending transfer to a nonzero owner.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Completes the two-step ownership transfer. Only callable by the pending owner.
    function acceptOwnership() external {
        if (pendingOwner == address(0) || msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }
}
