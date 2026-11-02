// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RouteFiEscrow
 * @notice Educational escrow for the RouteFi payment-routing simulator.
 *
 * Life of a payment:
 *   1. A payer calls createPayment() with test ETH and a registered, active provider ID.
 *      The contract holds the ETH (escrow).
 *   2. The off-chain routing engine simulates the payment through that provider.
 *   3. BEFORE the deadline (createdAt + REFUND_TIMEOUT) an operator calls one of:
 *        - settle()   -> provider succeeded, ETH is released to the merchant
 *        - reroute()  -> provider failed, retry with a provider NOT yet tried (max 3 attempts)
 *        - refund()   -> payment abandoned, ETH goes back to the payer
 *   4. From the deadline on, the payment is EXPIRED: it can no longer be settled or rerouted,
 *      only refunded - by the operator via refund(), or by the payer via claimRefund().
 *
 * If the 3rd provider also fails, nothing refunds automatically: the operator must call refund().
 * If the operator never does, the payer can claimRefund() once the deadline passes.
 *
 * Provider IDs are short names packed into bytes32, e.g. ethers.encodeBytes32String("FastPay").
 * Every step emits an event, giving a public, verifiable audit trail.
 * Uses test ETH only - not for real payments.
 */
contract RouteFiEscrow is Ownable2Step, ReentrancyGuard {
    enum Status {
        None, // 0 - payment ID does not exist
        Pending, // 1 - ETH is held in escrow
        Settled, // 2 - ETH released to merchant
        Refunded // 3 - ETH returned to payer
    }

    struct Payment {
        address payer;
        address merchant;
        uint256 amount; // in wei (1 ETH = 10^18 wei)
        bytes32 provider; // ID of the provider currently handling it
        uint8 attempts; // how many providers have been tried
        uint64 createdAt; // block timestamp when created
        Status status;
    }

    /// @notice How long a payment stays open. At the deadline it expires and becomes refund-only.
    uint256 public constant REFUND_TIMEOUT = 1 hours;

    /// @notice Maximum providers tried for one payment before it must be refunded.
    uint8 public constant MAX_ATTEMPTS = 3;

    uint256 public paymentCount;

    /// @dev Sum of all Pending payment amounts - what the contract owes. Never includes forced ETH.
    uint256 private totalEscrowed;

    mapping(uint256 => Payment) private payments;
    mapping(address => bool) public operators;

    mapping(bytes32 => bool) public providerRegistered;
    mapping(bytes32 => bool) public providerActive;
    bytes32[] private providerIds;

    /// @dev paymentId => providerId => already attempted for this payment
    mapping(uint256 => mapping(bytes32 => bool)) private tried;

    // ---------- Events (the on-chain audit log) ----------
    event PaymentCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        bytes32 provider
    );
    event PaymentRerouted(uint256 indexed id, bytes32 fromProvider, bytes32 toProvider, uint8 attempt);
    event PaymentSettled(uint256 indexed id, address indexed merchant, uint256 amount, bytes32 provider);
    event PaymentRefunded(uint256 indexed id, address indexed payer, uint256 amount, string reason);
    event OperatorUpdated(address indexed operator, bool allowed);
    event ProviderAdded(bytes32 indexed provider);
    event ProviderStatusChanged(bytes32 indexed provider, bool active);
    event SurplusSwept(address indexed to, uint256 amount);

    // ---------- Custom errors (cheaper and clearer than revert strings) ----------
    error InvalidAmount();
    error InvalidMerchant();
    error InvalidOperator();
    error InvalidRecipient();
    error InvalidProvider();
    error ProviderAlreadyRegistered(bytes32 provider);
    error ProviderUnavailable(bytes32 provider);
    error ProviderAlreadyTried(bytes32 provider);
    error NotOperator();
    error NotPayer();
    error PaymentNotPending();
    error PaymentExpired();
    error TooManyAttempts();
    error RefundNotYetAvailable();
    error TransferFailed();
    error NoSurplus();
    error RenounceDisabled();

    modifier onlyOperator() {
        if (!operators[msg.sender] && msg.sender != owner()) revert NotOperator();
        _;
    }

    modifier onlyPending(uint256 id) {
        if (payments[id].status != Status.Pending) revert PaymentNotPending();
        _;
    }

    /// @dev The deployer becomes the owner, and the owner is always an operator.
    /// @param initialProviders Provider IDs to register (and activate) at deployment.
    constructor(bytes32[] memory initialProviders) Ownable(msg.sender) {
        for (uint256 i = 0; i < initialProviders.length; i++) {
            _addProvider(initialProviders[i]);
        }
    }

    // ---------- Admin ----------

    /// @notice Owner grants or removes operator rights (who may settle/refund/reroute).
    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert InvalidOperator();
        operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    /// @notice Owner registers a new provider (active immediately).
    function addProvider(bytes32 provider) external onlyOwner {
        _addProvider(provider);
    }

    /// @notice Operator marks a registered provider as available or unavailable (e.g. simulated outage).
    function setProviderActive(bytes32 provider, bool active) external onlyOperator {
        if (!providerRegistered[provider]) revert InvalidProvider();
        providerActive[provider] = active;
        emit ProviderStatusChanged(provider, active);
    }

    /// @notice Owner recovers ETH that was forced into the contract (e.g. via selfdestruct).
    /// @dev Can only ever move balance ABOVE what is owed to pending payments.
    function sweepSurplus(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        uint256 amount = address(this).balance - totalEscrowed;
        if (amount == 0) revert NoSurplus();

        emit SurplusSwept(to, amount);
        _send(to, amount);
    }

    /// @notice Disabled: renouncing would leave nobody able to settle payments or manage operators.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------- Payer actions ----------

    /// @notice Lock ETH in escrow for `merchant`, routed through `provider`.
    /// @return id The new payment's ID.
    function createPayment(address merchant, bytes32 provider) external payable returns (uint256 id) {
        if (msg.value == 0) revert InvalidAmount();
        if (merchant == address(0) || merchant == msg.sender || merchant == address(this)) revert InvalidMerchant();
        if (!providerActive[provider]) revert ProviderUnavailable(provider);

        id = ++paymentCount; // IDs start at 1
        payments[id] = Payment({
            payer: msg.sender,
            merchant: merchant,
            amount: msg.value,
            provider: provider,
            attempts: 1,
            createdAt: uint64(block.timestamp),
            status: Status.Pending
        });
        tried[id][provider] = true;
        totalEscrowed += msg.value;

        emit PaymentCreated(id, msg.sender, merchant, msg.value, provider);
    }

    /// @notice Payer reclaims their ETH once the payment has expired.
    function claimRefund(uint256 id) external nonReentrant onlyPending(id) {
        Payment storage p = payments[id];
        if (msg.sender != p.payer) revert NotPayer();
        if (!_isExpired(p)) revert RefundNotYetAvailable();

        _refund(id, "timeout");
    }

    // ---------- Operator actions ----------

    /// @notice Provider succeeded: release the escrowed ETH to the merchant. Not allowed once expired.
    function settle(uint256 id) external onlyOperator nonReentrant onlyPending(id) {
        Payment storage p = payments[id];
        if (_isExpired(p)) revert PaymentExpired();

        // Checks-Effects-Interactions: update state BEFORE sending ETH.
        p.status = Status.Settled;
        totalEscrowed -= p.amount;
        emit PaymentSettled(id, p.merchant, p.amount, p.provider);

        _send(p.merchant, p.amount);
    }

    /// @notice Provider failed: switch to an active provider not yet tried for this payment,
    ///         keeping ETH in escrow. Not allowed once expired or after MAX_ATTEMPTS.
    function reroute(uint256 id, bytes32 newProvider) external onlyOperator onlyPending(id) {
        Payment storage p = payments[id];
        if (_isExpired(p)) revert PaymentExpired();
        if (p.attempts >= MAX_ATTEMPTS) revert TooManyAttempts();
        if (!providerActive[newProvider]) revert ProviderUnavailable(newProvider);
        if (tried[id][newProvider]) revert ProviderAlreadyTried(newProvider);

        bytes32 oldProvider = p.provider;
        p.provider = newProvider;
        p.attempts += 1;
        tried[id][newProvider] = true;

        emit PaymentRerouted(id, oldProvider, newProvider, p.attempts);
    }

    /// @notice All providers failed (or payment cancelled): return ETH to the payer.
    ///         Allowed before or after expiry.
    function refund(uint256 id, string calldata reason) external onlyOperator nonReentrant onlyPending(id) {
        _refund(id, reason);
    }

    // ---------- Views ----------

    function getPayment(uint256 id) external view returns (Payment memory) {
        return payments[id];
    }

    /// @notice Total ETH owed to pending payments (excludes any forced ETH).
    function escrowBalance() external view returns (uint256) {
        return totalEscrowed;
    }

    /// @notice ETH held above what is owed (forced in, recoverable via sweepSurplus).
    function surplus() external view returns (uint256) {
        return address(this).balance - totalEscrowed;
    }

    /// @notice Timestamp at which the payment expires and the payer may claimRefund(). 0 if it doesn't exist.
    function refundAvailableAt(uint256 id) external view returns (uint256) {
        Payment storage p = payments[id];
        return p.status == Status.None ? 0 : p.createdAt + REFUND_TIMEOUT;
    }

    /// @notice Whether `provider` has already been attempted for payment `id`.
    function wasTried(uint256 id, bytes32 provider) external view returns (bool) {
        return tried[id][provider];
    }

    /// @notice All registered provider IDs and whether each is currently active.
    function getProviders() external view returns (bytes32[] memory ids, bool[] memory active) {
        ids = providerIds;
        active = new bool[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            active[i] = providerActive[ids[i]];
        }
    }

    // ---------- Internal helpers ----------

    function _isExpired(Payment storage p) private view returns (bool) {
        return block.timestamp >= p.createdAt + REFUND_TIMEOUT;
    }

    function _addProvider(bytes32 provider) private {
        if (provider == bytes32(0)) revert InvalidProvider();
        if (providerRegistered[provider]) revert ProviderAlreadyRegistered(provider);

        providerRegistered[provider] = true;
        providerActive[provider] = true;
        providerIds.push(provider);
        emit ProviderAdded(provider);
        emit ProviderStatusChanged(provider, true);
    }

    function _refund(uint256 id, string memory reason) private {
        Payment storage p = payments[id];
        p.status = Status.Refunded;
        totalEscrowed -= p.amount;
        emit PaymentRefunded(id, p.payer, p.amount, reason);

        _send(p.payer, p.amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
