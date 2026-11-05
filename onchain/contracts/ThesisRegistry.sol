// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ThesisRegistry
/// @notice Append-only thesis hash registry on Arc. Supplied metadata is logged, not verified.
contract ThesisRegistry {
    error NotRelayer();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroHash();
    error ZeroPostedAt();
    error AlreadyAnchored();

    event ThesisAnchored(
        bytes32 indexed thesisHash,
        address indexed author,
        uint64 postedAt,
        uint256 priceAtPostE18,
        uint256 positionUsdAtPostE6
    );
    event RelayerChanged(address indexed previousRelayer, address indexed newRelayer);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    mapping(bytes32 => uint64) private _anchoredAt;

    /// @notice Address authorized to anchor thesis hashes.
    address public relayer;
    /// @notice Address authorized to manage the relayer and initiate ownership transfers.
    address public owner;
    /// @notice Address authorized to accept the pending ownership transfer.
    address public pendingOwner;

    /// @notice Initializes the nonzero owner and relayer.
    constructor(address initialOwner, address initialRelayer) {
        if (initialOwner == address(0) || initialRelayer == address(0)) revert ZeroAddress();
        owner = initialOwner;
        relayer = initialRelayer;
        emit OwnershipTransferred(address(0), initialOwner);
        emit RelayerChanged(address(0), initialRelayer);
    }

    /// @notice Permanently anchors a new hash and emits the supplied metadata.
    /// @dev Only the anchoring block timestamp is stored; postedAt is supplied by the relayer.
    function anchor(
        bytes32 thesisHash,
        address author,
        uint64 postedAt,
        uint256 priceAtPostE18,
        uint256 positionUsdAtPostE6
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (thesisHash == bytes32(0)) revert ZeroHash();
        if (author == address(0)) revert ZeroAddress();
        if (postedAt == 0) revert ZeroPostedAt();
        if (_anchoredAt[thesisHash] != 0) revert AlreadyAnchored();

        _anchoredAt[thesisHash] = uint64(block.timestamp);
        emit ThesisAnchored(thesisHash, author, postedAt, priceAtPostE18, positionUsdAtPostE6);
    }

    /// @notice Returns the anchoring block timestamp, or zero if the hash has never been anchored.
    function anchoredAt(bytes32 thesisHash) external view returns (uint64) {
        return _anchoredAt[thesisHash];
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
