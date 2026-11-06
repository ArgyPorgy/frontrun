// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PositionLedger} from "../PositionLedger.sol";
import {ReputationRegistry} from "../ReputationRegistry.sol";

contract PositionLedgerTest is Test {
    PositionLedger internal ledger;
    address internal owner = address(0xA);
    address internal relayer = address(0xB);
    address internal author = address(0xC);
    bytes32 internal constant THESIS = keccak256("thesis");

    function setUp() public {
        ledger = new PositionLedger(owner, relayer);
    }

    function _record(bytes32 id, uint8 action, uint32 heldBps) internal {
        vm.prank(relayer);
        ledger.record(THESIS, author, id, action, heldBps, 2e18, 1_000);
    }

    function test_startsAtFullyHeld() public view {
        (uint32 held, bool changed) = ledger.heldBpsOf(THESIS);
        assertEq(held, 10000);
        assertFalse(changed);
        assertEq(ledger.historyLength(THESIS), 0);
    }

    function test_keepsEveryChangeInOrder() public {
        _record(keccak256("1"), 2, 6000);
        _record(keccak256("2"), 3, 0);
        assertEq(ledger.historyLength(THESIS), 2);
        assertEq(ledger.recordAt(THESIS, 0).heldBps, 6000);
        assertEq(ledger.recordAt(THESIS, 1).action, 3);
        (uint32 held, bool changed) = ledger.heldBpsOf(THESIS);
        assertEq(held, 0);
        assertTrue(changed);
    }

    function test_stampsTheBlockTime() public {
        vm.warp(5_000);
        _record(keccak256("1"), 2, 6000);
        PositionLedger.Record memory r = ledger.recordAt(THESIS, 0);
        assertEq(r.recordedAt, 5_000);
        assertEq(r.occurredAt, 1_000);
    }

    function test_anEventCanOnlyBeWrittenOnce() public {
        _record(keccak256("1"), 2, 6000);
        assertTrue(ledger.isRecorded(keccak256("1")));
        vm.prank(relayer);
        vm.expectRevert(PositionLedger.AlreadyRecorded.selector);
        ledger.record(THESIS, author, keccak256("1"), 2, 5000, 2e18, 1_000);
    }

    function test_onlyTheRelayerCanWrite() public {
        vm.expectRevert(PositionLedger.NotRelayer.selector);
        ledger.record(THESIS, author, keccak256("1"), 2, 6000, 2e18, 1_000);
    }

    function test_rejectsEmptyValues() public {
        vm.startPrank(relayer);
        vm.expectRevert(PositionLedger.ZeroHash.selector);
        ledger.record(bytes32(0), author, keccak256("1"), 2, 6000, 2e18, 1_000);
        vm.expectRevert(PositionLedger.ZeroHash.selector);
        ledger.record(THESIS, author, bytes32(0), 2, 6000, 2e18, 1_000);
        vm.expectRevert(PositionLedger.ZeroAddress.selector);
        ledger.record(THESIS, address(0), keccak256("1"), 2, 6000, 2e18, 1_000);
        vm.expectRevert(PositionLedger.ZeroTime.selector);
        ledger.record(THESIS, author, keccak256("1"), 2, 6000, 2e18, 0);
        vm.stopPrank();
    }

    function test_ownerManagesTheRelayer() public {
        vm.prank(relayer);
        vm.expectRevert(PositionLedger.NotOwner.selector);
        ledger.setRelayer(address(0xD));
        vm.prank(owner);
        ledger.setRelayer(address(0xD));
        assertEq(ledger.relayer(), address(0xD));
    }

    function test_ownershipMovesInTwoSteps() public {
        vm.prank(owner);
        ledger.transferOwnership(address(0xD));
        assertEq(ledger.owner(), owner);
        vm.expectRevert(PositionLedger.NotPendingOwner.selector);
        ledger.acceptOwnership();
        vm.prank(address(0xD));
        ledger.acceptOwnership();
        assertEq(ledger.owner(), address(0xD));
    }
}

contract ReputationRegistryTest is Test {
    ReputationRegistry internal registry;
    address internal owner = address(0xA);
    address internal relayer = address(0xB);
    address internal wallet = address(0xC);

    function setUp() public {
        registry = new ReputationRegistry(owner, relayer);
    }

    function _attest(uint16 score) internal {
        vm.prank(relayer);
        registry.attest(wallet, score, 6000, 1250, 800, 7200, 50, 12);
    }

    function test_aWalletWithNoScoreReadsAsNever() public view {
        (uint16 score, uint64 attestedAt) = registry.scoreOf(wallet);
        assertEq(score, 0);
        assertEq(attestedAt, 0);
    }

    function test_anyoneCanReadAScore() public {
        vm.warp(9_000);
        _attest(72);
        vm.prank(address(0xE));
        (uint16 score, uint64 attestedAt) = registry.scoreOf(wallet);
        assertEq(score, 72);
        assertEq(attestedAt, 9_000);
        ReputationRegistry.Attestation memory a = registry.attestationOf(wallet);
        assertEq(a.winRateBps, 6000);
        assertEq(a.avgReturnBps, 1250);
        assertEq(a.closedPositions, 12);
    }

    function test_holdsNegativeReturns() public {
        vm.prank(relayer);
        registry.attest(wallet, 20, 1000, -2500, 4000, 60, 100, 5);
        assertEq(registry.attestationOf(wallet).avgReturnBps, -2500);
    }

    function test_aNewScoreReplacesTheOld() public {
        _attest(72);
        _attest(40);
        (uint16 score, ) = registry.scoreOf(wallet);
        assertEq(score, 40);
    }

    function test_onlyTheRelayerCanWrite() public {
        vm.expectRevert(ReputationRegistry.NotRelayer.selector);
        registry.attest(wallet, 72, 6000, 1250, 800, 7200, 50, 12);
    }

    function test_rejectsBadValues() public {
        vm.startPrank(relayer);
        vm.expectRevert(ReputationRegistry.ScoreOutOfRange.selector);
        registry.attest(wallet, 101, 6000, 1250, 800, 7200, 50, 12);
        vm.expectRevert(ReputationRegistry.ZeroAddress.selector);
        registry.attest(address(0), 72, 6000, 1250, 800, 7200, 50, 12);
        vm.stopPrank();
    }

    function test_ownerManagesTheRelayer() public {
        vm.prank(owner);
        registry.setRelayer(address(0xD));
        assertEq(registry.relayer(), address(0xD));
    }
}
