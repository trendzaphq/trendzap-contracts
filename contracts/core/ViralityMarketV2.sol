// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/LMSR.sol";
import "../libraries/FixedPointMath.sol";

/**
 * @title ViralityMarketV2
 * @notice Advanced prediction market using LMSR (Logarithmic Market Scoring Rule)
 * @dev Supports both native AVAX and ERC-20 (USDC) settlement.
 *      When settlementToken == address(0), the market uses native AVAX.
 *      When settlementToken != address(0), the market uses that ERC-20 token.
 *
 * Key Features:
 * - LMSR pricing: Smooth, continuous prices without order book
 * - Bounded loss: Market maker's max loss is predictable
 * - No LP needed: LMSR provides automatic liquidity
 * - Better slippage: Large trades have bounded price impact
 * - Dual settlement: Native AVAX or ERC-20 (USDC)
 *
 * @author TrendZap Team
 */
contract ViralityMarketV2 is AccessControl, ReentrancyGuard, Pausable {
    using LMSR for uint256;
    using FixedPointMath for uint256;
    using SafeERC20 for IERC20;

    // ============ Constants ============

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MIN_BET_AMOUNT_NATIVE = 0.001 ether;
    uint256 public constant MAX_BET_AMOUNT_NATIVE = 1000 ether;
    uint256 public constant MIN_BET_AMOUNT_TOKEN = 1e6; // 1 USDC (6 decimals)
    uint256 public constant MAX_BET_AMOUNT_TOKEN = 100_000e6; // 100K USDC
    uint256 public constant PLATFORM_FEE_BPS = 200; // 2%
    uint256 public constant CREATOR_FEE_BPS = 50; // 0.5%
    uint256 public constant BPS_DENOMINATOR = 10000;

    // Default liquidity parameter (controls price sensitivity)
    // Higher b = less sensitive prices, more liquidity needed
    uint256 public constant DEFAULT_LIQUIDITY_PARAM = 100 ether;

    // ============ Enums ============

    enum Platform {
        TWITTER,
        YOUTUBE,
        TIKTOK,
        INSTAGRAM
    }
    enum MetricType {
        LIKES,
        VIEWS,
        RETWEETS,
        COMMENTS,
        SHARES
    }
    enum MarketStatus {
        PENDING,
        ACTIVE,
        CLOSED,
        RESOLVED,
        CANCELLED,
        DISPUTED
    }
    enum Outcome {
        NONE,
        OVER,
        UNDER
    }

    // ============ Structs ============

    struct MarketParams {
        string postUrl;
        Platform platform;
        MetricType metricType;
        uint256 threshold;
        uint256 startTime;
        uint256 endTime;
        uint256 resolutionTime;
    }

    struct MarketState {
        uint256 qOver; // Outstanding OVER shares
        uint256 qUnder; // Outstanding UNDER shares
        uint256 b; // Liquidity parameter
        uint256 totalVolume; // Total trading volume
        uint256 feesCollected; // Fees held for treasury + creator, part of poolBalance
        uint256 poolBalance; // ALL settlement asset held for this market
        /// @dev Sum of every trader's remaining cost basis, used to settle refunds
        ///      pro-rata when a market is cancelled.
        uint256 totalCostBasis;
        /// @dev poolBalance snapshotted at resolution (or cancellation), after fees.
        ///      Every payout divides this fixed number by a fixed share total, so
        ///      claims are order-independent and sum exactly to the pot.
        uint256 settlementPool;
        /// @dev Winning-share total frozen at resolution.
        uint256 settlementShares;
    }

    struct Market {
        MarketParams params;
        MarketState state;
        MarketStatus status;
        Outcome outcome;
        uint256 resolvedValue;
        address creator;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    struct Position {
        uint256 overShares;
        uint256 underShares;
        uint256 overCost; // Total cost basis for OVER
        uint256 underCost; // Total cost basis for UNDER
        bool claimed;
    }

    // ============ State Variables ============

    uint256 public nextMarketId;
    address public treasury;

    /// @notice Settlement token address. address(0) = native AVAX, otherwise ERC-20 (USDC)
    address public settlementToken;

    // Market ID => Market
    mapping(uint256 => Market) public markets;

    // Market ID => User => Position
    mapping(uint256 => mapping(address => Position)) public positions;

    /**
     * @dev Withdrawable balances, credited instead of pushed.
     *
     * _distributeFees used to transfer the creator fee inline during resolveMarket.
     * The creator is an arbitrary user-supplied address, so a contract that reverts on
     * receive would make resolveMarket revert too — permanently blocking resolution of
     * its own market. Fees are now credited here and pulled via withdraw().
     */
    mapping(address => uint256) public pendingWithdrawals;

    // ============ Events ============

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        string postUrl,
        Platform platform,
        MetricType metricType,
        uint256 threshold,
        uint256 endTime,
        uint256 liquidityParam
    );

    event SharesBought(
        uint256 indexed marketId,
        address indexed trader,
        bool isOver,
        uint256 shares,
        uint256 cost,
        uint256 newPriceOver,
        uint256 newPriceUnder
    );

    event SharesSold(
        uint256 indexed marketId,
        address indexed trader,
        bool isOver,
        uint256 shares,
        uint256 payout,
        uint256 newPriceOver,
        uint256 newPriceUnder
    );

    event MarketResolved(
        uint256 indexed marketId,
        Outcome outcome,
        uint256 resolvedValue,
        uint256 timestamp
    );

    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed user,
        uint256 shares,
        uint256 payout
    );

    event MarketStatusChanged(
        uint256 indexed marketId,
        MarketStatus oldStatus,
        MarketStatus newStatus
    );

    event FeesWithdrawn(
        uint256 indexed marketId,
        uint256 platformFee,
        uint256 creatorFee
    );

    event MarketCancelled(uint256 indexed marketId, string reason);

    event RefundClaimed(
        uint256 indexed marketId,
        address indexed user,
        uint256 amount
    );

    event Withdrawn(address indexed account, uint256 amount);

    /// @notice Emitted when a market resolves with no holders on the winning side.
    event UnclaimedPoolSwept(uint256 indexed marketId, uint256 amount);

    // ============ Constructor ============

    constructor(address _treasury, address _oracle, address _settlementToken) {
        require(_treasury != address(0), "Invalid treasury");

        treasury = _treasury;
        settlementToken = _settlementToken; // address(0) = native AVAX

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);

        if (_oracle != address(0)) {
            _grantRole(ORACLE_ROLE, _oracle);
        }
    }

    // ============ Modifiers ============

    /// @dev Returns true if this market settles in an ERC-20 token (e.g. USDC)
    function isTokenSettlement() public view returns (bool) {
        return settlementToken != address(0);
    }

    // ============ External Functions ============

    /**
     * @notice Create a new prediction market
     * @param params Market parameters
     * @param initialBet Initial bet amount to seed liquidity
     * @param betOnOver True to bet on OVER with initial bet
     * @return marketId The ID of the created market
     * @dev For native AVAX: send initialBet as msg.value
     *      For ERC-20: approve this contract first, then pass initialBet
     */
    function createMarket(
        MarketParams calldata params,
        uint256 initialBet,
        bool betOnOver
    ) external payable nonReentrant whenNotPaused returns (uint256 marketId) {
        require(bytes(params.postUrl).length > 0, "Invalid post URL");
        require(params.threshold > 0, "Invalid threshold");
        require(params.startTime >= block.timestamp, "Invalid start time");
        require(params.endTime > params.startTime, "Invalid end time");
        require(
            params.resolutionTime > params.endTime,
            "Invalid resolution time"
        );

        // The seed bet is subject to the same bounds as any other trade. It was
        // previously unbounded, so a market could be seeded below the minimum — which
        // produced a tiny liquidity parameter and a market that ran away after a few
        // hundred units of one-sided volume.
        if (initialBet > 0) {
            if (isTokenSettlement()) {
                require(msg.value == 0, "Do not send native value in token mode");
                require(initialBet >= MIN_BET_AMOUNT_TOKEN, "Bet too small");
                require(initialBet <= MAX_BET_AMOUNT_TOKEN, "Bet too large");
                IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), initialBet);
            } else {
                require(initialBet >= MIN_BET_AMOUNT_NATIVE, "Bet too small");
                require(initialBet <= MAX_BET_AMOUNT_NATIVE, "Bet too large");
                require(msg.value >= initialBet, "Insufficient payment");
            }
        } else if (isTokenSettlement()) {
            require(msg.value == 0, "Do not send native value in token mode");
        }

        marketId = nextMarketId++;

        // Calculate liquidity parameter based on initial bet
        // Larger initial bets = higher liquidity = tighter spreads
        uint256 b = initialBet > 0
            ? LMSR.calculateLiquidityParameter(initialBet * 2)
            : DEFAULT_LIQUIDITY_PARAM;

        markets[marketId] = Market({
            params: params,
            state: MarketState({
                qOver: 0,
                qUnder: 0,
                b: b,
                totalVolume: 0,
                feesCollected: 0,
                poolBalance: 0,
                totalCostBasis: 0,
                settlementPool: 0,
                settlementShares: 0
            }),
            status: MarketStatus.ACTIVE,
            outcome: Outcome.NONE,
            resolvedValue: 0,
            creator: msg.sender,
            createdAt: block.timestamp,
            resolvedAt: 0
        });

        emit MarketCreated(
            marketId,
            msg.sender,
            params.postUrl,
            params.platform,
            params.metricType,
            params.threshold,
            params.endTime,
            b
        );

        // Place initial bet if provided.
        if (initialBet > 0) {
            _buyShares(marketId, initialBet, betOnOver, msg.sender, 0);
        }

        // Refund native change. Previously `payment` was msg.value in native mode, so
        // anything sent above initialBet was silently absorbed into the market.
        if (!isTokenSettlement() && msg.value > initialBet) {
            _sendValue(msg.sender, msg.value - initialBet);
        }
    }

    /**
     * @notice Buy shares in a market outcome
     * @param marketId The market ID
     * @param isOver True to buy OVER shares, false for UNDER
     * @param amount Amount of settlement token (only used for ERC-20 mode; native uses msg.value)
     */
    function buyShares(
        uint256 marketId,
        bool isOver,
        uint256 amount,
        uint256 minSharesOut,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused {
        require(block.timestamp <= deadline, "Transaction expired");

        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        uint256 payment;
        if (isTokenSettlement()) {
            require(msg.value == 0, "Do not send native value in token mode");
            require(amount >= MIN_BET_AMOUNT_TOKEN, "Bet too small");
            require(amount <= MAX_BET_AMOUNT_TOKEN, "Bet too large");
            IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), amount);
            payment = amount;
        } else {
            require(msg.value >= MIN_BET_AMOUNT_NATIVE, "Bet too small");
            require(msg.value <= MAX_BET_AMOUNT_NATIVE, "Bet too large");
            payment = msg.value;
        }

        _buyShares(marketId, payment, isOver, msg.sender, minSharesOut);
    }

    /**
     * @notice Buy shares without slippage protection (backwards-compatible overload)
     * @dev Prefer buyShares(id, isOver, amount, minSharesOut, deadline). This form
     *      accepts any fill, so a trade can be sandwiched or reordered freely.
     */
    function buyShares(
        uint256 marketId,
        bool isOver,
        uint256 amount
    ) external payable nonReentrant whenNotPaused {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        uint256 payment;
        if (isTokenSettlement()) {
            require(msg.value == 0, "Do not send native value in token mode");
            require(amount >= MIN_BET_AMOUNT_TOKEN, "Bet too small");
            require(amount <= MAX_BET_AMOUNT_TOKEN, "Bet too large");
            IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), amount);
            payment = amount;
        } else {
            require(msg.value >= MIN_BET_AMOUNT_NATIVE, "Bet too small");
            require(msg.value <= MAX_BET_AMOUNT_NATIVE, "Bet too large");
            payment = msg.value;
        }

        _buyShares(marketId, payment, isOver, msg.sender, 0);
    }

    /**
     * @notice Buy shares with native AVAX (convenience for backward compat)
     * @param marketId The market ID
     * @param isOver True to buy OVER shares, false for UNDER
     */
    function buyShares(
        uint256 marketId,
        bool isOver
    ) external payable nonReentrant whenNotPaused {
        require(!isTokenSettlement(), "Use buyShares(id,isOver,amount) for token settlement");
        require(msg.value >= MIN_BET_AMOUNT_NATIVE, "Bet too small");
        require(msg.value <= MAX_BET_AMOUNT_NATIVE, "Bet too large");

        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        _buyShares(marketId, msg.value, isOver, msg.sender, 0);
    }

    /**
     * @notice Sell shares back to the market
     * @param marketId The market ID
     * @param shares Number of shares to sell
     * @param isOver True to sell OVER shares, false for UNDER
     */
    function sellShares(
        uint256 marketId,
        uint256 shares,
        bool isOver,
        uint256 minPayout,
        uint256 deadline
    ) external nonReentrant whenNotPaused {
        require(block.timestamp <= deadline, "Transaction expired");
        _sellShares(marketId, shares, isOver, minPayout);
    }

    /**
     * @notice Sell shares without slippage protection (backwards-compatible overload)
     */
    function sellShares(
        uint256 marketId,
        uint256 shares,
        bool isOver
    ) external nonReentrant whenNotPaused {
        _sellShares(marketId, shares, isOver, 0);
    }

    /**
     * @dev Sell `shares` back to the market maker.
     *
     * The pool is debited only by what actually leaves the contract, and the fee stays
     * inside poolBalance under feesCollected. Previously buys credited the pool net of
     * fees while sells debited the full LMSR value, so the pool drifted below the cost
     * function by the accumulated fees and `poolBalance -= payout` eventually reverted
     * on underflow — permanently disabling selling for that market while buying still
     * worked.
     */
    function _sellShares(
        uint256 marketId,
        uint256 shares,
        bool isOver,
        uint256 minPayout
    ) internal {
        require(shares > 0, "Must sell positive shares");

        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        Position storage position = positions[marketId][msg.sender];
        MarketState storage state = market.state;

        int256 tradeCost = LMSR.calculateTradeCost(
            state.qOver,
            state.qUnder,
            isOver ? -int256(shares) : int256(0),
            isOver ? int256(0) : -int256(shares),
            state.b
        );

        require(tradeCost < 0, "Sell would cost money");
        uint256 payout = uint256(-tradeCost);

        // Reduce the cost basis in proportion to the shares sold.
        //
        // sellShares used to leave overCost/underCost untouched, so a trader could buy
        // in, sell everything back, and still claim a full refund on the original
        // stake if the market was later cancelled.
        if (isOver) {
            require(position.overShares >= shares, "Insufficient OVER shares");
            uint256 basisOut = (position.overCost * shares) / position.overShares;
            position.overCost -= basisOut;
            state.totalCostBasis -= basisOut;
            state.qOver -= shares;
            position.overShares -= shares;
        } else {
            require(position.underShares >= shares, "Insufficient UNDER shares");
            uint256 basisOut = (position.underCost * shares) / position.underShares;
            position.underCost -= basisOut;
            state.totalCostBasis -= basisOut;
            state.qUnder -= shares;
            position.underShares -= shares;
        }

        uint256 fee = (payout * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netPayout = payout - fee;
        require(netPayout >= minPayout, "Slippage: payout too low");

        state.feesCollected += fee;
        // Only the amount actually leaving the contract is debited; the fee remains in
        // poolBalance, earmarked by feesCollected.
        state.poolBalance -= netPayout;

        (uint256 newPriceOver, uint256 newPriceUnder) = LMSR.getPrices(
            state.qOver,
            state.qUnder,
            state.b
        );

        _transferOut(msg.sender, netPayout);

        emit SharesSold(
            marketId,
            msg.sender,
            isOver,
            shares,
            netPayout,
            newPriceOver,
            newPriceUnder
        );
    }

    /**
     * @notice Resolve a market with the final metric value
     * @param marketId The market ID
     * @param metricValue The final metric value from oracle
     */
    function resolveMarket(
        uint256 marketId,
        uint256 metricValue
    ) external onlyRole(ORACLE_ROLE) {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.ACTIVE ||
                market.status == MarketStatus.CLOSED,
            "Cannot resolve"
        );
        require(
            block.timestamp >= market.params.endTime,
            "Too early to resolve"
        );

        MarketStatus oldStatus = market.status;
        market.resolvedValue = metricValue;
        market.outcome = metricValue >= market.params.threshold
            ? Outcome.OVER
            : Outcome.UNDER;
        market.status = MarketStatus.RESOLVED;
        market.resolvedAt = block.timestamp;

        // Credit fees, then freeze the settlement pot.
        _distributeFees(marketId);

        MarketState storage state = market.state;
        state.settlementPool = state.poolBalance;
        state.settlementShares = market.outcome == Outcome.OVER
            ? state.qOver
            : state.qUnder;

        // Nobody held the winning side: no claim is possible, so sweep the pot to the
        // treasury rather than stranding it in the contract forever.
        if (state.settlementShares == 0 && state.settlementPool > 0) {
            uint256 unclaimed = state.settlementPool;
            state.settlementPool = 0;
            state.poolBalance -= unclaimed;
            pendingWithdrawals[treasury] += unclaimed;
            emit UnclaimedPoolSwept(marketId, unclaimed);
        }

        emit MarketStatusChanged(marketId, oldStatus, MarketStatus.RESOLVED);
        emit MarketResolved(
            marketId,
            market.outcome,
            metricValue,
            block.timestamp
        );
    }

    /**
     * @notice Claim winnings from a resolved market
     * @param marketId The market ID
     *
     * @dev Payouts divide a pot frozen at resolution by a share total frozen at
     *      resolution, so every winner receives the same proportion regardless of when
     *      they claim, and the payouts sum to the pot.
     *
     *      This previously divided the LIVE poolBalance by the live winning-share
     *      total. poolBalance shrank with each claim while the share total did not, so
     *      each successive claimant received less for an identical position (100 /
     *      66.7 / 44.4 for three equal winners) and roughly 30% of the pot was
     *      permanently stranded. Payout also depended on claim order, making it a race.
     */
    function claimWinnings(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.RESOLVED, "Market not resolved");

        Position storage position = positions[marketId][msg.sender];
        require(!position.claimed, "Already claimed");

        uint256 winningShares;
        if (market.outcome == Outcome.OVER) {
            winningShares = position.overShares;
        } else if (market.outcome == Outcome.UNDER) {
            winningShares = position.underShares;
        }

        require(winningShares > 0, "No winning shares");

        MarketState storage state = market.state;
        require(state.settlementShares > 0, "Nothing to distribute");

        position.claimed = true;

        uint256 payout = (winningShares * state.settlementPool) /
            state.settlementShares;

        // Defensive: rounding must never let claims exceed what is held.
        if (payout > state.poolBalance) payout = state.poolBalance;
        state.poolBalance -= payout;

        _transferOut(msg.sender, payout);

        emit WinningsClaimed(marketId, msg.sender, winningShares, payout);
    }

    /**
     * @notice Close market for betting (keeper function)
     * @param marketId The market ID
     */
    function closeMarket(uint256 marketId) external onlyRole(KEEPER_ROLE) {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Not active");
        require(block.timestamp >= market.params.endTime, "Not ended yet");

        market.status = MarketStatus.CLOSED;
        emit MarketStatusChanged(
            marketId,
            MarketStatus.ACTIVE,
            MarketStatus.CLOSED
        );
    }

    /**
     * @notice Cancel a market, making every remaining stake refundable
     * @param marketId The market ID
     * @param reason Human-readable cancellation reason, emitted for indexers
     *
     * @dev No fee is charged on a cancelled market, so feesCollected is released back
     *      into the refund pot.
     */
    function cancelMarket(
        uint256 marketId,
        string calldata reason
    ) external onlyRole(ADMIN_ROLE) {
        Market storage market = markets[marketId];
        MarketStatus oldStatus = market.status;
        require(
            oldStatus == MarketStatus.PENDING ||
                oldStatus == MarketStatus.ACTIVE ||
                oldStatus == MarketStatus.CLOSED,
            "Cannot cancel"
        );

        market.status = MarketStatus.CANCELLED;

        MarketState storage state = market.state;
        // Cancelled markets take no fee; the whole balance is refundable.
        state.feesCollected = 0;
        state.settlementPool = state.poolBalance;
        state.settlementShares = state.totalCostBasis;

        // Nobody holds a cost basis (everyone sold out before the cancellation), so no
        // refund can be claimed. Sweep the residual to the treasury rather than
        // leaving it locked in the contract.
        if (state.totalCostBasis == 0 && state.poolBalance > 0) {
            uint256 residual = state.poolBalance;
            state.settlementPool = 0;
            state.poolBalance = 0;
            pendingWithdrawals[treasury] += residual;
            emit UnclaimedPoolSwept(marketId, residual);
        }

        // Capture the old status BEFORE the assignment. This used to read
        // market.status afterwards, so the event always reported CANCELLED -> CANCELLED
        // and no indexer could tell what the market had been.
        emit MarketStatusChanged(marketId, oldStatus, MarketStatus.CANCELLED);
        emit MarketCancelled(marketId, reason);
    }

    /**
     * @notice Claim a refund from a cancelled market
     * @param marketId The market ID
     *
     * @dev Refunds are pro-rata against the balance actually held, using each
     *      trader's remaining cost basis as the weight. Because both the pot and the
     *      basis total are frozen at cancellation, refunds are order-independent and
     *      sum exactly to the pot.
     *
     *      This previously paid out `overCost + underCost` — the GROSS amount paid in,
     *      including fees — from a pool that had only ever been credited net of fees.
     *      Refunds owed therefore exceeded the pool by exactly the fees collected, it
     *      never decremented poolBalance so the contract had no record of what it had
     *      paid, and the shortfall was absorbed by whoever claimed last.
     */
    function claimRefund(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.CANCELLED, "Not cancelled");

        Position storage position = positions[marketId][msg.sender];
        require(!position.claimed, "Already claimed");

        uint256 basis = position.overCost + position.underCost;
        require(basis > 0, "Nothing to refund");

        MarketState storage state = market.state;
        require(state.settlementShares > 0, "Nothing to distribute");

        position.claimed = true;

        uint256 refund = (basis * state.settlementPool) / state.settlementShares;
        if (refund > state.poolBalance) refund = state.poolBalance;
        state.poolBalance -= refund;

        _transferOut(msg.sender, refund);

        emit RefundClaimed(marketId, msg.sender, refund);
    }

    /**
     * @notice Withdraw fees or swept balances credited to the caller
     * @dev Pull payment. Fees used to be pushed inline during resolveMarket, so a
     *      creator address that reverts on receive would revert the resolution itself
     *      and permanently block its own market from settling.
     */
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        _transferOut(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ============ View Functions ============

    /// @dev Reverts with a clear message for ids that were never created.
    modifier marketExists(uint256 marketId) {
        require(marketId < nextMarketId, "Market does not exist");
        _;
    }

    /**
     * @notice Get current prices for a market
     * @param marketId The market ID
     * @return priceOver Price of OVER (0-1e18)
     * @return priceUnder Price of UNDER (0-1e18)
     */
    function getPrices(
        uint256 marketId
    ) external view marketExists(marketId) returns (uint256 priceOver, uint256 priceUnder) {
        Market storage market = markets[marketId];
        return
            LMSR.getPrices(
                market.state.qOver,
                market.state.qUnder,
                market.state.b
            );
    }

    /**
     * @notice Get implied probabilities in basis points (0-10000)
     * @param marketId The market ID
     * @return probOver Probability of OVER, in bps
     * @return probUnder Probability of UNDER, in bps
     * @dev Basis points rather than whole percent: the previous version divided into a
     *      0-100 integer and discarded everything below a full percentage point.
     */
    function getProbabilitiesBps(
        uint256 marketId
    ) external view marketExists(marketId) returns (uint256 probOver, uint256 probUnder) {
        Market storage market = markets[marketId];
        return
            LMSR.getProbabilitiesBps(
                market.state.qOver,
                market.state.qUnder,
                market.state.b
            );
    }

    /**
     * @notice Calculate cost to buy shares
     * @param marketId The market ID
     * @param shares Number of shares to buy
     * @param isOver True for OVER, false for UNDER
     * @return cost Cost in wei
     */
    function quoteBuy(
        uint256 marketId,
        uint256 shares,
        bool isOver
    ) external view marketExists(marketId) returns (uint256 cost) {
        Market storage market = markets[marketId];
        return
            LMSR.calculateBuyCost(
                market.state.qOver,
                market.state.qUnder,
                shares,
                isOver,
                market.state.b
            );
    }

    /**
     * @notice Calculate shares received for a payment
     * @param marketId The market ID
     * @param payment Payment amount
     * @param isOver True for OVER, false for UNDER
     * @return shares Number of shares
     */
    function quoteSharesForPayment(
        uint256 marketId,
        uint256 payment,
        bool isOver
    ) external view marketExists(marketId) returns (uint256 shares) {
        Market storage market = markets[marketId];
        return
            LMSR.calculateSharesForPayment(
                market.state.qOver,
                market.state.qUnder,
                payment,
                isOver,
                market.state.b
            );
    }

    /**
     * @notice Get market data
     * @param marketId The market ID
     */
    function getMarket(uint256 marketId) external view returns (Market memory) {
        return markets[marketId];
    }

    /**
     * @notice Get user position
     * @param marketId The market ID
     * @param user User address
     */
    function getPosition(
        uint256 marketId,
        address user
    ) external view returns (Position memory) {
        return positions[marketId][user];
    }

    // ============ Internal Functions ============

    function _buyShares(
        uint256 marketId,
        uint256 payment,
        bool isOver,
        address trader,
        uint256 minSharesOut
    ) internal {
        Market storage market = markets[marketId];
        MarketState storage state = market.state;
        Position storage position = positions[marketId][trader];

        // Fee is taken from the payment; the remainder funds the LMSR position.
        uint256 fee = (payment * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netPayment = payment - fee;
        state.feesCollected += fee;

        uint256 shares = LMSR.calculateSharesForPayment(
            state.qOver,
            state.qUnder,
            netPayment,
            isOver,
            state.b
        );

        require(shares > 0, "Payment too small");
        require(shares >= minSharesOut, "Slippage: too few shares");

        if (isOver) {
            state.qOver += shares;
            position.overShares += shares;
            position.overCost += payment;
        } else {
            state.qUnder += shares;
            position.underShares += shares;
            position.underCost += payment;
        }

        state.totalVolume += payment;
        state.totalCostBasis += payment;
        // GROSS. feesCollected is a claim against this balance, not a separate pot.
        state.poolBalance += payment;

        // Get new prices
        (uint256 newPriceOver, uint256 newPriceUnder) = LMSR.getPrices(
            state.qOver,
            state.qUnder,
            state.b
        );

        emit SharesBought(
            marketId,
            trader,
            isOver,
            shares,
            payment,
            newPriceOver,
            newPriceUnder
        );
    }

    function _distributeFees(uint256 marketId) internal {
        Market storage market = markets[marketId];
        uint256 totalFees = market.state.feesCollected;

        if (totalFees == 0) return;

        // Split: 80% platform, 20% creator (0.5% of the 2.5% headline total)
        uint256 creatorFee = (totalFees * CREATOR_FEE_BPS) /
            (PLATFORM_FEE_BPS + CREATOR_FEE_BPS);
        uint256 platformFee = totalFees - creatorFee;

        market.state.feesCollected = 0;
        // Fees were held inside poolBalance; remove them now that they are earmarked.
        market.state.poolBalance -= totalFees;

        // Credited, not transferred — see withdraw().
        pendingWithdrawals[treasury] += platformFee;
        pendingWithdrawals[market.creator] += creatorFee;

        emit FeesWithdrawn(marketId, platformFee, creatorFee);
    }

    /// @dev Unified transfer function: ERC-20 or native depending on settlementToken
    function _transferOut(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (isTokenSettlement()) {
            IERC20(settlementToken).safeTransfer(to, amount);
        } else {
            _sendValue(to, amount);
        }
    }

    /// @dev Send native value, reverting on failure.
    function _sendValue(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    // ============ Admin Functions ============

    function setTreasury(address _treasury) external onlyRole(ADMIN_ROLE) {
        require(_treasury != address(0), "Invalid treasury");
        treasury = _treasury;
    }

    function setSettlementToken(address _token) external onlyRole(ADMIN_ROLE) {
        require(nextMarketId == 0, "Cannot change after markets exist");
        settlementToken = _token;
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ============ Receive ============

    receive() external payable {}
}
