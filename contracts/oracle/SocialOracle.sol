// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "../interfaces/IViralityMarket.sol";

/**
 * @title SocialOracle
 * @notice Oracle contract for fetching social media metrics via Chainlink
 * @dev Uses Chainlink Any API to query TrendZap oracle service
 * @author TrendZap Team
 */
contract SocialOracle is ChainlinkClient, AccessControl {
    using Chainlink for Chainlink.Request;

    // ============ Constants ============

    bytes32 public constant REQUESTER_ROLE = keccak256("REQUESTER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ============ State Variables ============

    bytes32 public jobId;
    uint256 public fee;
    string public oracleApiUrl;

    // Request ID => Market ID mapping
    mapping(bytes32 => uint256) public requestToMarket;
    // Market ID => Request ID mapping
    mapping(uint256 => bytes32) public marketToRequest;
    // Market ID => Latest metric value
    mapping(uint256 => uint256) public latestMetricValue;
    // Market ID => Last update timestamp
    mapping(uint256 => uint256) public lastUpdateTime;

    // ============ Events ============

    event MetricRequested(
        bytes32 indexed requestId,
        uint256 indexed marketId,
        string postUrl
    );

    event MetricFulfilled(
        bytes32 indexed requestId,
        uint256 indexed marketId,
        uint256 metricValue
    );

    event OracleConfigUpdated(
        bytes32 jobId,
        uint256 fee,
        string apiUrl
    );

    // ============ Constructor ============

    constructor(
        address _linkToken,
        address _oracle,
        bytes32 _jobId,
        uint256 _fee,
        string memory _oracleApiUrl
    ) {
        setChainlinkToken(_linkToken);
        setChainlinkOracle(_oracle);
        
        jobId = _jobId;
        fee = _fee;
        oracleApiUrl = _oracleApiUrl;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(REQUESTER_ROLE, msg.sender);
    }

    // ============ External Functions ============

    /**
     * @notice Request metric data for a market
     * @param marketId The market ID
     * @param postUrl The social media post URL
     * @param platform The platform (twitter, tiktok, etc.)
     * @param metricType The metric type (likes, retweets, etc.)
     * @return requestId The Chainlink request ID
     */
    function requestMetric(
        uint256 marketId,
        string calldata postUrl,
        string calldata platform,
        string calldata metricType
    ) 
        external 
        onlyRole(REQUESTER_ROLE)
        returns (bytes32 requestId) 
    {
        Chainlink.Request memory req = buildChainlinkRequest(
            jobId,
            address(this),
            this.fulfill.selector
        );

        // Build the API URL with query parameters
        string memory url = string(
            abi.encodePacked(
                oracleApiUrl,
                "/metrics?",
                "url=", postUrl,
                "&platform=", platform,
                "&metric=", metricType
            )
        );

        req.add("get", url);
        req.add("path", "data,value");
        req.addInt("times", 1);

        requestId = sendChainlinkRequest(req, fee);

        requestToMarket[requestId] = marketId;
        marketToRequest[marketId] = requestId;

        emit MetricRequested(requestId, marketId, postUrl);
    }

    /**
     * @notice Callback function for Chainlink oracle response
     * @param _requestId The request ID
     * @param _metricValue The metric value returned by oracle
     */
    function fulfill(bytes32 _requestId, uint256 _metricValue) 
        public 
        recordChainlinkFulfillment(_requestId) 
    {
        uint256 marketId = requestToMarket[_requestId];
        
        latestMetricValue[marketId] = _metricValue;
        lastUpdateTime[marketId] = block.timestamp;

        emit MetricFulfilled(_requestId, marketId, _metricValue);
    }

    // ============ View Functions ============

    /**
     * @notice Get the latest metric value for a market
     * @param marketId The market ID
     * @return value The metric value
     * @return timestamp When it was last updated
     */
    function getLatestMetric(uint256 marketId) 
        external 
        view 
        returns (uint256 value, uint256 timestamp) 
    {
        return (latestMetricValue[marketId], lastUpdateTime[marketId]);
    }

    // ============ Admin Functions ============

    /**
     * @notice Update oracle configuration
     * @param _jobId New Chainlink job ID
     * @param _fee New fee amount
     * @param _oracleApiUrl New oracle API URL
     */
    function updateOracleConfig(
        bytes32 _jobId,
        uint256 _fee,
        string calldata _oracleApiUrl
    ) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        jobId = _jobId;
        fee = _fee;
        oracleApiUrl = _oracleApiUrl;

        emit OracleConfigUpdated(_jobId, _fee, _oracleApiUrl);
    }

    /**
     * @notice Update Chainlink oracle address
     * @param _oracle New oracle address
     */
    function updateChainlinkOracle(address _oracle) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        setChainlinkOracle(_oracle);
    }

    /**
     * @notice Withdraw LINK tokens
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function withdrawLink(address to, uint256 amount) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        LinkTokenInterface link = LinkTokenInterface(chainlinkTokenAddress());
        require(link.transfer(to, amount), "Transfer failed");
    }
}
