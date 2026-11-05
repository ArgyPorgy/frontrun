// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ThesisRegistry} from "../ThesisRegistry.sol";

contract ThesisRegistryTest is Test {
    ThesisRegistry internal reg;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal author = makeAddr("author");
    address internal stranger = makeAddr("stranger");
    address internal newOwner = makeAddr("newOwner");

    bytes32 internal constant H = keccak256("thesis-1");
    uint64 internal constant POSTED = 1_700_000_000;
    uint256 internal constant PRICE = 2_500e18;
    uint256 internal constant POS = 10_000e6;

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

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new ThesisRegistry(owner, relayer);
    }

    // ---------------------------------------------------------------- constructor

    function test_Constructor_SetsOwnerAndRelayer() public view {
        assertEq(reg.owner(), owner);
        assertEq(reg.relayer(), relayer);
        assertEq(reg.pendingOwner(), address(0));
    }

    function test_Constructor_EmitsInitialEvents() public {
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, true, false, false);
        emit RelayerChanged(address(0), relayer);
        new ThesisRegistry(owner, relayer);
    }

    function test_Constructor_RevertsZeroOwner() public {
        vm.expectRevert(ThesisRegistry.ZeroAddress.selector);
        new ThesisRegistry(address(0), relayer);
    }

    function test_Constructor_RevertsZeroRelayer() public {
        vm.expectRevert(ThesisRegistry.ZeroAddress.selector);
        new ThesisRegistry(owner, address(0));
    }

    // ---------------------------------------------------------------- anchor happy path

    function test_Anchor_HappyPath_EmitsAllFields() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit ThesisAnchored(H, author, POSTED, PRICE, POS);
        vm.prank(relayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
    }

    function test_Anchor_EmitEventViaContractType() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit ThesisRegistry.ThesisAnchored(H, author, POSTED, PRICE, POS);
        vm.prank(relayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
    }

    function test_Anchor_AnchoredAtEqualsBlockTimestamp() public {
        assertEq(reg.anchoredAt(H), 0);
        vm.prank(relayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
        assertEq(reg.anchoredAt(H), uint64(block.timestamp));
        assertEq(reg.anchoredAt(H), 1_800_000_000);
    }

    function test_Anchor_AnchoredAtUsesAnchoringTimeNotPostedAt() public {
        vm.warp(1_900_000_123);
        vm.prank(relayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
        assertEq(reg.anchoredAt(H), 1_900_000_123);
    }

    function test_Anchor_AllowsZeroPriceAndPosition() public {
        vm.prank(relayer);
        reg.anchor(H, author, POSTED, 0, 0);
        assertEq(reg.anchoredAt(H), uint64(block.timestamp));
    }

    function test_Anchor_DifferentHashesIndependent() public {
        bytes32 h2 = keccak256("thesis-2");
        vm.startPrank(relayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
        vm.warp(block.timestamp + 100);
        reg.anchor(h2, author, POSTED, PRICE, POS);
        vm.stopPrank();
        assertEq(reg.anchoredAt(h2), reg.anchoredAt(H) + 100);
    }

    // ---------------------------------------------------------------- anchor reverts

    function test_Anchor_RevertsNotRelayer_Stranger() public {
        vm.prank(stranger);
        vm.expectRevert(ThesisRegistry.NotRelayer.selector);
        reg.anchor(H, author, POSTED, PRICE, POS);
    }

    function test_Anchor_RevertsNotRelayer_OwnerWhenRolesDiffer() public {
        assertTrue(owner != relayer);
        vm.prank(owner);
        vm.expectRevert(ThesisRegistry.NotRelayer.selector);
        reg.anchor(H, author, POSTED, PRICE, POS);
        assertEq(reg.anchoredAt(H), 0);
    }

    function test_Anchor_RevertsAlreadyAnchored_AndKeepsOriginalTimestamp() public {
        vm.prank(relayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
        uint64 first = reg.anchoredAt(H);

        vm.warp(block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.AlreadyAnchored.selector);
        reg.anchor(H, makeAddr("other"), POSTED + 1, 1, 1);

        assertEq(reg.anchoredAt(H), first);
    }

    function test_Anchor_RevertsZeroHash() public {
        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.ZeroHash.selector);
        reg.anchor(bytes32(0), author, POSTED, PRICE, POS);
    }

    function test_Anchor_RevertsZeroAuthor() public {
        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.ZeroAddress.selector);
        reg.anchor(H, address(0), POSTED, PRICE, POS);
    }

    function test_Anchor_RevertsZeroPostedAt() public {
        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.ZeroPostedAt.selector);
        reg.anchor(H, author, 0, PRICE, POS);
    }

    function test_Anchor_NotRelayerCheckedBeforeValidation() public {
        vm.prank(stranger);
        vm.expectRevert(ThesisRegistry.NotRelayer.selector);
        reg.anchor(bytes32(0), address(0), 0, 0, 0);
    }

    // ---------------------------------------------------------------- relayer rotation

    function test_SetRelayer_HappyPath_EmitsEvent() public {
        address newRelayer = makeAddr("newRelayer");
        vm.expectEmit(true, true, false, false, address(reg));
        emit RelayerChanged(relayer, newRelayer);
        vm.prank(owner);
        reg.setRelayer(newRelayer);
        assertEq(reg.relayer(), newRelayer);
    }

    function test_SetRelayer_OldRelayerLosesAccess_NewGainsIt() public {
        address newRelayer = makeAddr("newRelayer");
        vm.prank(owner);
        reg.setRelayer(newRelayer);

        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.NotRelayer.selector);
        reg.anchor(H, author, POSTED, PRICE, POS);

        vm.prank(newRelayer);
        reg.anchor(H, author, POSTED, PRICE, POS);
        assertEq(reg.anchoredAt(H), uint64(block.timestamp));
    }

    function test_SetRelayer_RevertsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ThesisRegistry.NotOwner.selector);
        reg.setRelayer(stranger);
    }

    function test_SetRelayer_RevertsForRelayerItself() public {
        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.NotOwner.selector);
        reg.setRelayer(relayer);
    }

    function test_SetRelayer_RevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ThesisRegistry.ZeroAddress.selector);
        reg.setRelayer(address(0));
        assertEq(reg.relayer(), relayer);
    }

    // ---------------------------------------------------------------- two-step ownership

    function test_TransferOwnership_EmitsStartedAndSetsPending() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit OwnershipTransferStarted(owner, newOwner);
        vm.prank(owner);
        reg.transferOwnership(newOwner);

        assertEq(reg.pendingOwner(), newOwner);
        assertEq(reg.owner(), owner, "owner unchanged until accept");
    }

    function test_TransferOwnership_RevertsNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ThesisRegistry.NotOwner.selector);
        reg.transferOwnership(newOwner);
        assertEq(reg.pendingOwner(), address(0));
    }

    function test_TransferOwnership_RevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ThesisRegistry.ZeroAddress.selector);
        reg.transferOwnership(address(0));
    }

    function test_TransferOwnership_CanReplacePending() public {
        address other = makeAddr("other");
        vm.startPrank(owner);
        reg.transferOwnership(newOwner);
        reg.transferOwnership(other);
        vm.stopPrank();
        assertEq(reg.pendingOwner(), other);

        vm.prank(newOwner);
        vm.expectRevert(ThesisRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
    }

    function test_AcceptOwnership_HappyPath_EmitsAndClearsPending() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);

        vm.expectEmit(true, true, false, false, address(reg));
        emit OwnershipTransferred(owner, newOwner);
        vm.prank(newOwner);
        reg.acceptOwnership();

        assertEq(reg.owner(), newOwner);
        assertEq(reg.pendingOwner(), address(0));
    }

    function test_AcceptOwnership_RevertsNonPending() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);

        vm.prank(stranger);
        vm.expectRevert(ThesisRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();

        // current owner is not the pending owner either
        vm.prank(owner);
        vm.expectRevert(ThesisRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();

        assertEq(reg.owner(), owner);
    }

    function test_AcceptOwnership_RevertsWhenNoPending() public {
        vm.prank(stranger);
        vm.expectRevert(ThesisRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
    }

    function test_AcceptOwnership_ZeroAddressCannotAcceptWhenNoPending() public {
        vm.prank(address(0));
        vm.expectRevert(ThesisRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
        assertEq(reg.owner(), owner);
    }

    function test_AcceptOwnership_OldOwnerLosesAccess_NewOwnerGainsIt() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        vm.prank(newOwner);
        reg.acceptOwnership();

        vm.prank(owner);
        vm.expectRevert(ThesisRegistry.NotOwner.selector);
        reg.setRelayer(makeAddr("x"));

        vm.prank(owner);
        vm.expectRevert(ThesisRegistry.NotOwner.selector);
        reg.transferOwnership(owner);

        address r2 = makeAddr("r2");
        vm.prank(newOwner);
        reg.setRelayer(r2);
        assertEq(reg.relayer(), r2);
    }

    function test_AcceptOwnership_CannotBeReplayed() public {
        vm.prank(owner);
        reg.transferOwnership(newOwner);
        vm.prank(newOwner);
        reg.acceptOwnership();

        vm.prank(newOwner);
        vm.expectRevert(ThesisRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();
    }

    // ---------------------------------------------------------------- native value rejected

    function test_Value_PlainSendReverts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(reg).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(reg).balance, 0);
        assertEq(stranger.balance, 1 ether);
    }

    function test_Value_AnchorCalldataWithValueReverts() public {
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        (bool ok,) = address(reg).call{value: 1 wei}(
            abi.encodeCall(ThesisRegistry.anchor, (H, author, POSTED, PRICE, POS))
        );
        assertFalse(ok);
        assertEq(address(reg).balance, 0);
        assertEq(reg.anchoredAt(H), 0);
    }

    function test_Value_UnknownSelectorWithValueReverts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(reg).call{value: 1 wei}(abi.encodeWithSelector(bytes4(0xdeadbeef), uint256(1)));
        assertFalse(ok);
        assertEq(address(reg).balance, 0);
    }

    function test_Value_UnknownSelectorWithoutValueReverts() public {
        (bool ok,) = address(reg).call(abi.encodeWithSelector(bytes4(0xdeadbeef)));
        assertFalse(ok);
    }

    function test_Value_NonPayableSettersRejectValue() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(reg).call{value: 1 wei}(abi.encodeCall(ThesisRegistry.setRelayer, (stranger)));
        assertFalse(ok);
        assertEq(address(reg).balance, 0);
        assertEq(reg.relayer(), relayer);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_Anchor_ArbitraryValidInputs(
        bytes32 hash,
        address who,
        uint64 postedAt,
        uint256 price,
        uint256 pos,
        uint64 ts
    ) public {
        vm.assume(hash != bytes32(0));
        vm.assume(who != address(0));
        postedAt = uint64(bound(postedAt, 1, type(uint64).max));
        ts = uint64(bound(ts, 1, type(uint64).max));
        vm.warp(ts);

        vm.expectEmit(true, true, false, true, address(reg));
        emit ThesisAnchored(hash, who, postedAt, price, pos);
        vm.prank(relayer);
        reg.anchor(hash, who, postedAt, price, pos);

        assertEq(reg.anchoredAt(hash), ts);

        vm.prank(relayer);
        vm.expectRevert(ThesisRegistry.AlreadyAnchored.selector);
        reg.anchor(hash, who, postedAt, price, pos);
        assertEq(reg.anchoredAt(hash), ts);
    }

    function testFuzz_AnchoredAt_UnanchoredIsZero(bytes32 hash, bytes32 otherHash) public {
        assertEq(reg.anchoredAt(hash), 0);

        vm.assume(otherHash != bytes32(0) && otherHash != hash);
        vm.prank(relayer);
        reg.anchor(otherHash, author, POSTED, PRICE, POS);
        assertEq(reg.anchoredAt(hash), 0);
    }

    function testFuzz_Anchor_NonRelayerAlwaysReverts(address caller) public {
        vm.assume(caller != relayer);
        vm.prank(caller);
        vm.expectRevert(ThesisRegistry.NotRelayer.selector);
        reg.anchor(H, author, POSTED, PRICE, POS);
    }
}
