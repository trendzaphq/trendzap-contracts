// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IViralityMarket
 * @notice Interface for TrendZap Virality Market contracts
 * @dev Defines the core functionality for social media prediction markets
 */
interface IViralityMarket {
    // ============ Enums ============

    enum MarketStatus {
        PENDING,    // Market created, waiting for start
        ACTIVE,     // Market is open for betting
        CLOSED,     // Betting closed, awaiting resolution
        RESOLVED,   // Market resolved with outcome
        CANCELLED   // Market cancelled, refunds available
    }

    enum Outcome {
        NONE,       // Not yet resolved
        OVER,       // Metric exceeded threshold
        UNDER       // Metric did not exceed threshold
    }

    enum MetricType {
        LIKES,
        RETWEETS,
        REPLIES,
        VIEWS,
        FOLLOWERS
    }

    enum Platform {
        TWITTER,
        TIKTOK,
        INSTAGRAM,
        YOUTUBE
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

    struct MarketData {
        MarketParams params;
        MarketStatus status;
        Outcome outcome;
        uint256 totalOverStake;
        uint256 totalUnderStake;
        uint256 resolvedMetricValue;
        address creator;
        uint256 createdAt;
    }

    struct Position {
        uint256 overStake;
        uint256 underStake;
        bool claimed;
    }

    // ============ Events ============

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        string postUrl,
        Platform platform,
        MetricType metricType,
        uint256 threshold,
        uint256 endTime
    );

    event BetPlaced(
        uint256 indexed marketId,
        address indexed bettor,
        Outcome outcome,
        uint256 amount
    );

    event MarketResolved(
        uint256 indexed marketId,
        Outcome outcome,
        uint256 metricValue
    );

    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed claimer,
        uint256 amount
    );

    event MarketCancelled(
        uint256 indexed marketId,
        string reason
    );

    // ============ Functions ============

    function createMarket(MarketParams calldata params) external returns (uint256 marketId);

    function placeBet(uint256 marketId, Outcome outcome) external payable;

    function resolveMarket(uint256 marketId, uint256 metricValue) external;

    function claimWinnings(uint256 marketId) external;

    function cancelMarket(uint256 marketId, string calldata reason) external;

    function getMarket(uint256 marketId) external view returns (MarketData memory);

    function getPosition(uint256 marketId, address user) external view returns (Position memory);

    function calculatePayout(uint256 marketId, address user) external view returns (uint256);
}
