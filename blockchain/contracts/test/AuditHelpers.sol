// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TEST-ONLY contracts used by test/Audit.test.js to simulate hostile or broken
// counterparties. Never deploy these anywhere real.

interface IRouteFiEscrow {
    function createPayment(address merchant, bytes32 provider) external payable returns (uint256);
    function claimRefund(uint256 id) external;
}

/// @dev A payer/merchant contract with NO receive() or fallback(): every ETH transfer to it fails.
contract RejectingParty {
    uint256 public lastPaymentId;

    function pay(IRouteFiEscrow escrow, address merchant, bytes32 provider) external payable {
        lastPaymentId = escrow.createPayment{value: msg.value}(merchant, provider);
    }

    function claim(IRouteFiEscrow escrow, uint256 id) external {
        escrow.claimRefund(id);
    }
}

/// @dev A payer that tries to call claimRefund() again while receiving its refund (classic double-withdraw).
contract ReentrantPayer {
    IRouteFiEscrow public immutable escrow;
    uint256 public paymentId;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(IRouteFiEscrow _escrow) {
        escrow = _escrow;
    }

    function pay(address merchant) external payable {
        paymentId = escrow.createPayment{value: msg.value}(merchant, bytes32("FastPay"));
    }

    function claim() external {
        escrow.claimRefund(paymentId);
    }

    receive() external payable {
        if (!reentryAttempted) {
            reentryAttempted = true;
            try escrow.claimRefund(paymentId) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}

/// @dev Forces ETH into any address via selfdestruct, bypassing the target's lack of receive().
contract ForceSend {
    constructor() payable {}

    function boom(address payable to) external {
        selfdestruct(to);
    }
}
