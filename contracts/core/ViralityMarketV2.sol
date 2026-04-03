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
        uint256 feesCollected; // Platform fees collected
        uint256 poolBalance; // Net ETH held for this market's payouts
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

    struct Trade {
        address trader;
        uint256 marketId;
        bool isOver;
        bool isBuy;
        uint256 shares;
        uint256 cost;
        uint256 timestamp;
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

    // All trades (for indexing and analytics)
    Trade[] public trades;

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
    ) external payable whenNotPaused returns (uint256 marketId) {
        require(bytes(params.postUrl).length > 0, "Invalid post URL");
        require(params.threshold > 0, "Invalid threshold");
        require(params.startTime >= block.timestamp, "Invalid start time");
        require(params.endTime > params.startTime, "Invalid end time");
        require(
            params.resolutionTime > params.endTime,
            "Invalid resolution time"
        );

        if (initialBet > 0) {
            if (isTokenSettlement()) {
                // Pull ERC-20 tokens from caller
                IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), initialBet);
            } else {
                require(msg.value >= initialBet, "Insufficient payment");
            }
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
                poolBalance: 0
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

        // Place initial bet if provided
        if (initialBet > 0) {
            uint256 payment = isTokenSettlement() ? initialBet : msg.value;
            _buyShares(marketId, payment, betOnOver, msg.sender);
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
        uint256 amount
    ) external payable nonReentrant whenNotPaused {
        uint256 payment;
        if (isTokenSettlement()) {
            require(amount >= MIN_BET_AMOUNT_TOKEN, "Bet too small");
            require(amount <= MAX_BET_AMOUNT_TOKEN, "Bet too large");
            IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), amount);
            payment = amount;
        } else {
            require(msg.value >= MIN_BET_AMOUNT_NATIVE, "Bet too small");
            require(msg.value <= MAX_BET_AMOUNT_NATIVE, "Bet too large");
            payment = msg.value;
        }

        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        _buyShares(marketId, payment, isOver, msg.sender);
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

        _buyShares(marketId, msg.value, isOver, msg.sender);
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
        bool isOver
    ) external nonReentrant whenNotPaused {
        require(shares > 0, "Must sell positive shares");

        Market storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        Position storage position = positions[marketId][msg.sender];

        if (isOver) {
            require(position.overShares >= shares, "Insufficient OVER shares");
        } else {
            require(
                position.underShares >= shares,
                "Insufficient UNDER shares"
            );
        }

        MarketState storage state = market.state;

        // Calculate payout for selling shares (negative cost = payout)
        int256 tradeCost = LMSR.calculateTradeCost(
            state.qOver,
            state.qUnder,
            isOver ? -int256(shares) : int256(0),
            isOver ? int256(0) : -int256(shares),
            state.b
        );

        require(tradeCost < 0, "Sell would cost money");
        uint256 payout = uint256(-tradeCost);

        // Update state
        if (isOver) {
            state.qOver -= shares;
            position.overShares -= shares;
        } else {
            state.qUnder -= shares;
            position.underShares -= shares;
        }

        // Apply fee
        uint256 fee = (payout * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netPayout = payout - fee;
        state.feesCollected += fee;
        state.poolBalance -= payout; // remove gross from pool, fee stays in contract

        // Get new prices
        (uint256 newPriceOver, uint256 newPriceUnder) = LMSR.getPrices(
            state.qOver,
            state.qUnder,
            state.b
        );

        // Record trade
        trades.push(
            Trade({
                trader: msg.sender,
                marketId: marketId,
                isOver: isOver,
                isBuy: false,
                shares: shares,
                cost: payout,
                timestamp: block.timestamp
            })
        );

        // Transfer payout
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

        emit MarketStatusChanged(marketId, oldStatus, MarketStatus.RESOLVED);
        emit MarketResolved(
            marketId,
            market.outcome,
            metricValue,
            block.timestamp
        );

        // Distribute fees
        _distributeFees(marketId);
    }

    /**
     * @notice Claim winnings from a resolved market
     * @param marketId The market ID
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

        position.claimed = true;

        // Proportional payout from pool
        uint256 totalWinningShares;
        if (market.outcome == Outcome.OVER) {
            totalWinningShares = market.state.qOver;
        } else {
            totalWinningShares = market.state.qUnder;
        }

        uint256 payout = (winningShares * market.state.poolBalance) /
            totalWinningShares;
        market.state.poolBalance -= payout;

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
     * @notice Cancel a market (refunds all bets)
     * @param marketId The market ID
     */
    function cancelMarket(
        uint256 marketId,
        string calldata reason
    ) external onlyRole(ADMIN_ROLE) {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.PENDING ||
                market.status == MarketStatus.ACTIVE ||
                market.status == MarketStatus.CLOSED,
            "Cannot cancel"
        );

        market.status = MarketStatus.CANCELLED;
        emit MarketStatusChanged(
            marketId,
            market.status,
            MarketStatus.CANCELLED
        );
    }

    /**
     * @notice Claim refund from cancelled market
     * @param marketId The market ID
     */
    function claimRefund(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.CANCELLED, "Not cancelled");

        Position storage position = positions[marketId][msg.sender];
        require(!position.claimed, "Already claimed");

        uint256 refund = position.overCost + position.underCost;
        require(refund > 0, "Nothing to refund");

        position.claimed = true;

        _transferOut(msg.sender, refund);
    }

    // ============ View Functions ============

    /**
     * @notice Get current prices for a market
     * @param marketId The market ID
     * @return priceOver Price of OVER (0-1e18)
     * @return priceUnder Price of UNDER (0-1e18)
     */
    function getPrices(
        uint256 marketId
    ) external view returns (uint256 priceOver, uint256 priceUnder) {
        Market storage market = markets[marketId];
        return
            LMSR.getPrices(
                market.state.qOver,
                market.state.qUnder,
                market.state.b
            );
    }

    /**
     * @notice Get implied probabilities as percentages
     * @param marketId The market ID
     * @return probOver Probability of OVER (0-100)
     * @return probUnder Probability of UNDER (0-100)
     */
    function getProbabilities(
        uint256 marketId
    ) external view returns (uint256 probOver, uint256 probUnder) {
        Market storage market = markets[marketId];
        return
            LMSR.getProbabilities(
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
    ) external view returns (uint256 cost) {
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
    ) external view returns (uint256 shares) {
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

    /**
     * @notice Get total number of trades
     */
    function getTradeCount() external view returns (uint256) {
        return trades.length;
    }

    // ============ Internal Functions ============

    function _buyShares(
        uint256 marketId,
        uint256 payment,
        bool isOver,
        address trader
    ) internal {
        Market storage market = markets[marketId];
        MarketState storage state = market.state;
        Position storage position = positions[marketId][trader];

        // Apply fee to payment
        uint256 fee = (payment * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netPayment = payment - fee;
        state.feesCollected += fee;

        // Calculate shares for net payment
        uint256 shares = LMSR.calculateSharesForPayment(
            state.qOver,
            state.qUnder,
            netPayment,
            isOver,
            state.b
        );

        require(shares > 0, "Payment too small");

        // Update state
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
        state.poolBalance += netPayment; // track ETH held for payouts

        // Get new prices
        (uint256 newPriceOver, uint256 newPriceUnder) = LMSR.getPrices(
            state.qOver,
            state.qUnder,
            state.b
        );

        // Record trade
        trades.push(
            Trade({
                trader: trader,
                marketId: marketId,
                isOver: isOver,
                isBuy: true,
                shares: shares,
                cost: payment,
                timestamp: block.timestamp
            })
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

        // Split: 80% platform, 20% creator (0.5% of 2.5% total)
        uint256 creatorFee = (totalFees * CREATOR_FEE_BPS) /
            (PLATFORM_FEE_BPS + CREATOR_FEE_BPS);
        uint256 platformFee = totalFees - creatorFee;

        // Transfer to treasury
        _transferOut(treasury, platformFee);

        // Transfer to creator
        _transferOut(market.creator, creatorFee);

        market.state.feesCollected = 0;

        emit FeesWithdrawn(marketId, platformFee, creatorFee);
    }

    /// @dev Unified transfer function: ERC-20 or native depending on settlementToken
    function _transferOut(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (isTokenSettlement()) {
            IERC20(settlementToken).safeTransfer(to, amount);
        } else {
            (bool success, ) = to.call{value: amount}("");
            require(success, "Transfer failed");
        }
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
