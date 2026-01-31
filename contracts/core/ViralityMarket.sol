// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../interfaces/IViralityMarket.sol";

/**
 * @title ViralityMarket
 * @notice Core prediction market contract for TrendZap
 * @dev Handles market creation, betting, resolution, and payouts
 * @author TrendZap Team
 */
contract ViralityMarket is IViralityMarket, AccessControl, ReentrancyGuard, Pausable {
    // ============ Constants ============

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint256 public constant MIN_BET_AMOUNT = 0.001 ether;
    uint256 public constant MAX_BET_AMOUNT = 100 ether;
    uint256 public constant PLATFORM_FEE_BPS = 200; // 2%
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ============ State Variables ============

    uint256 public nextMarketId;
    address public treasury;

    mapping(uint256 => MarketData) public markets;
    mapping(uint256 => mapping(address => Position)) public positions;

    // ============ Constructor ============

    constructor(address _treasury, address _oracle) {
        require(_treasury != address(0), "Invalid treasury");
        require(_oracle != address(0), "Invalid oracle");

        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, _oracle);
    }

    // ============ External Functions ============

    /**
     * @notice Create a new prediction market
     * @param params Market parameters
     * @return marketId The ID of the created market
     */
    function createMarket(MarketParams calldata params) 
        external 
        whenNotPaused 
        returns (uint256 marketId) 
    {
        require(bytes(params.postUrl).length > 0, "Invalid post URL");
        require(params.threshold > 0, "Invalid threshold");
        require(params.startTime >= block.timestamp, "Invalid start time");
        require(params.endTime > params.startTime, "Invalid end time");
        require(params.resolutionTime > params.endTime, "Invalid resolution time");

        marketId = nextMarketId++;

        markets[marketId] = MarketData({
            params: params,
            status: MarketStatus.PENDING,
            outcome: Outcome.NONE,
            totalOverStake: 0,
            totalUnderStake: 0,
            resolvedMetricValue: 0,
            creator: msg.sender,
            createdAt: block.timestamp
        });

        emit MarketCreated(
            marketId,
            msg.sender,
            params.postUrl,
            params.platform,
            params.metricType,
            params.threshold,
            params.endTime
        );
    }

    /**
     * @notice Place a bet on a market outcome
     * @param marketId The market ID
     * @param outcome OVER or UNDER
     */
    function placeBet(uint256 marketId, Outcome outcome) 
        external 
        payable 
        nonReentrant 
        whenNotPaused 
    {
        require(outcome == Outcome.OVER || outcome == Outcome.UNDER, "Invalid outcome");
        require(msg.value >= MIN_BET_AMOUNT, "Bet too small");
        require(msg.value <= MAX_BET_AMOUNT, "Bet too large");

        MarketData storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Market not active");
        require(block.timestamp < market.params.endTime, "Betting closed");

        Position storage position = positions[marketId][msg.sender];

        if (outcome == Outcome.OVER) {
            position.overStake += msg.value;
            market.totalOverStake += msg.value;
        } else {
            position.underStake += msg.value;
            market.totalUnderStake += msg.value;
        }

        emit BetPlaced(marketId, msg.sender, outcome, msg.value);
    }

    /**
     * @notice Resolve a market with the final metric value
     * @param marketId The market ID
     * @param metricValue The final metric value from oracle
     */
    function resolveMarket(uint256 marketId, uint256 metricValue) 
        external 
        onlyRole(ORACLE_ROLE) 
    {
        MarketData storage market = markets[marketId];
        require(market.status == MarketStatus.CLOSED, "Market not closed");
        require(block.timestamp >= market.params.resolutionTime, "Too early to resolve");

        market.resolvedMetricValue = metricValue;
        market.outcome = metricValue >= market.params.threshold ? Outcome.OVER : Outcome.UNDER;
        market.status = MarketStatus.RESOLVED;

        // Transfer platform fee to treasury
        uint256 totalPool = market.totalOverStake + market.totalUnderStake;
        uint256 fee = (totalPool * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        
        if (fee > 0) {
            (bool success, ) = treasury.call{value: fee}("");
            require(success, "Fee transfer failed");
        }

        emit MarketResolved(marketId, market.outcome, metricValue);
    }

    /**
     * @notice Claim winnings from a resolved market
     * @param marketId The market ID
     */
    function claimWinnings(uint256 marketId) external nonReentrant {
        MarketData storage market = markets[marketId];
        require(market.status == MarketStatus.RESOLVED, "Market not resolved");

        Position storage position = positions[marketId][msg.sender];
        require(!position.claimed, "Already claimed");

        uint256 payout = calculatePayout(marketId, msg.sender);
        require(payout > 0, "No winnings");

        position.claimed = true;

        (bool success, ) = msg.sender.call{value: payout}("");
        require(success, "Payout failed");

        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    /**
     * @notice Cancel a market (admin only)
     * @param marketId The market ID
     * @param reason Cancellation reason
     */
    function cancelMarket(uint256 marketId, string calldata reason) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        MarketData storage market = markets[marketId];
        require(
            market.status == MarketStatus.PENDING || 
            market.status == MarketStatus.ACTIVE,
            "Cannot cancel"
        );

        market.status = MarketStatus.CANCELLED;

        emit MarketCancelled(marketId, reason);
    }

    // ============ View Functions ============

    /**
     * @notice Get market data
     * @param marketId The market ID
     * @return MarketData struct
     */
    function getMarket(uint256 marketId) external view returns (MarketData memory) {
        return markets[marketId];
    }

    /**
     * @notice Get user position in a market
     * @param marketId The market ID
     * @param user User address
     * @return Position struct
     */
    function getPosition(uint256 marketId, address user) 
        external 
        view 
        returns (Position memory) 
    {
        return positions[marketId][user];
    }

    /**
     * @notice Calculate potential payout for a user
     * @param marketId The market ID
     * @param user User address
     * @return payout Amount user can claim
     */
    function calculatePayout(uint256 marketId, address user) 
        public 
        view 
        returns (uint256 payout) 
    {
        MarketData storage market = markets[marketId];
        Position storage position = positions[marketId][user];

        if (market.status != MarketStatus.RESOLVED) return 0;
        if (position.claimed) return 0;

        uint256 totalPool = market.totalOverStake + market.totalUnderStake;
        uint256 fee = (totalPool * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 poolAfterFee = totalPool - fee;

        if (market.outcome == Outcome.OVER && position.overStake > 0) {
            payout = (position.overStake * poolAfterFee) / market.totalOverStake;
        } else if (market.outcome == Outcome.UNDER && position.underStake > 0) {
            payout = (position.underStake * poolAfterFee) / market.totalUnderStake;
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice Activate a pending market
     * @param marketId The market ID
     */
    function activateMarket(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        MarketData storage market = markets[marketId];
        require(market.status == MarketStatus.PENDING, "Not pending");
        require(block.timestamp >= market.params.startTime, "Too early");

        market.status = MarketStatus.ACTIVE;
    }

    /**
     * @notice Close an active market for betting
     * @param marketId The market ID
     */
    function closeMarket(uint256 marketId) external onlyRole(ADMIN_ROLE) {
        MarketData storage market = markets[marketId];
        require(market.status == MarketStatus.ACTIVE, "Not active");

        market.status = MarketStatus.CLOSED;
    }

    /**
     * @notice Update treasury address
     * @param _treasury New treasury address
     */
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_treasury != address(0), "Invalid treasury");
        treasury = _treasury;
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
