// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PositionLedger
/// @notice Append-only history of what a thesis's author did with their position after posting.
/// @dev A thesis is identified by the hash it was anchored under in ThesisRegistry. Nothing here can be edited.
contract PositionLedger {
    error NotRelayer();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroHash();
    error ZeroTime();
    error AlreadyRecorded();

    /// @notice What changed: 1 added to the position, 2 trimmed it, 3 exited, 4 moved tokens out with no sale.
    struct Record {
        uint8 action;
        uint32 heldBps;
        uint64 occurredAt;
        uint64 recordedAt;
        uint256 priceE18;
    }

    event PositionRecorded(
        bytes32 indexed thesisHash,
        address indexed author,
        bytes32 indexed eventId,
        uint8 action,
        uint32 heldBps,
        uint256 priceE18,
        uint64 occurredAt
    );
    event RelayerChanged(address indexed previousRelayer, address indexed newRelayer);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    mapping(bytes32 => Record[]) private _history;
    mapping(bytes32 => bool) private _recorded;

    /// @notice Address authorized to write records.
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

    /// @notice Appends one change to a thesis's history. An event id can only ever be written once.
    /// @param heldBps What the author holds now as a share of what they held at posting. 10000 is all of it.
    function record(
        bytes32 thesisHash,
        address author,
        bytes32 eventId,
        uint8 action,
        uint32 heldBps,
        uint256 priceE18,
        uint64 occurredAt
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (thesisHash == bytes32(0) || eventId == bytes32(0)) revert ZeroHash();
        if (author == address(0)) revert ZeroAddress();
        if (occurredAt == 0) revert ZeroTime();
        if (_recorded[eventId]) revert AlreadyRecorded();

        _recorded[eventId] = true;
        _history[thesisHash].push(Record(action, heldBps, occurredAt, uint64(block.timestamp), priceE18));
        emit PositionRecorded(thesisHash, author, eventId, action, heldBps, priceE18, occurredAt);
    }

    /// @notice Whether this event has already been written.
    function isRecorded(bytes32 eventId) external view returns (bool) {
        return _recorded[eventId];
    }

    /// @notice How many changes this thesis has on record.
    function historyLength(bytes32 thesisHash) external view returns (uint256) {
        return _history[thesisHash].length;
    }

    /// @notice One change from a thesis's history, oldest first.
    function recordAt(bytes32 thesisHash, uint256 index) external view returns (Record memory) {
        return _history[thesisHash][index];
    }

    /// @notice What the author holds now as a share of their position at posting, and whether anything has changed.
    function heldBpsOf(bytes32 thesisHash) external view returns (uint32 heldBps, bool changed) {
        Record[] storage history = _history[thesisHash];
        if (history.length == 0) return (10000, false);
        return (history[history.length - 1].heldBps, true);
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
