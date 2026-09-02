// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
// ViralityMarketV2 is referenced by address only — see setSingletonMarket().

/**
 * @title MarketFactoryV2
 * @notice Factory for deploying TrendZap prediction markets
 * @dev Uses minimal proxy pattern for gas-efficient deployments
 * 
 * Features:
 * - Minimal proxy (EIP-1167) for cheap deployments
 * - Singleton market contract with per-market state
 * - Role-based access control
 * - Market registry and validation
 * 
 * @author TrendZap Team
 */
contract MarketFactoryV2 is AccessControl, Pausable {
    using Clones for address;

    // ============ Constants ============

    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ============ State Variables ============

    /// @notice Implementation contract for minimal proxy
    address public marketImplementation;

    /// @notice Singleton market contract (all markets in one contract)
    address public singletonMarket;

    /// @notice Treasury address for fee collection
    address public treasury;

    /// @notice Oracle address for market resolution
    address public oracle;

    /// @notice Position tokens contract
    address public positionsToken;

    /// @notice Settlement token address (address(0) = native AVAX)
    address public settlementToken;

    /// @notice All deployed proxy markets (if using proxy pattern)
    address[] public deployedProxyMarkets;

    /// @notice Mapping to check if address is valid market
    mapping(address => bool) public isValidMarket;

    /// @notice Whether to use singleton pattern (true) or deploy proxies (false)
    bool public useSingleton;

    /// @notice Market creation fee (can be 0)
    uint256 public creationFee;

    // ============ Events ============

    event SingletonMarketSet(address indexed market);
    event MarketImplementationSet(address indexed implementation);
    event ProxyMarketDeployed(address indexed proxy, uint256 indexed index);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event PositionsTokenSet(address indexed token);
    event SettlementTokenUpdated(address indexed oldToken, address indexed newToken);
    event FeesWithdrawn(address indexed to, uint256 amount);

    // ============ Constructor ============

    constructor(
        address _treasury,
        address _oracle,
        address _settlementToken
    ) {
        require(_treasury != address(0), "Invalid treasury");
        require(_oracle != address(0), "Invalid oracle");

        treasury = _treasury;
        oracle = _oracle;
        settlementToken = _settlementToken;
        useSingleton = true; // Default to singleton pattern

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(DEPLOYER_ROLE, msg.sender);
    }

    // ============ Initialization ============

    // deploySingletonMarket() was removed.
    //
    // It was the only thing that made this factory embed ViralityMarketV2's full
    // bytecode via `new`, which pushed the factory to 26,952 bytes — past the 24,576
    // byte contract size limit, making it undeployable. Nothing called it: deploy-v2.ts
    // deploys the market separately and calls setSingletonMarket() below, which is the
    // pattern the live deployment actually used.

    /**
     * @notice Set an existing contract as singleton market
     * @param market Address of existing market contract
     */
    function setSingletonMarket(address market) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        require(market != address(0), "Invalid market");
        singletonMarket = market;
        isValidMarket[market] = true;

        emit SingletonMarketSet(market);
    }

    /**
     * @notice Set market implementation for proxy pattern
     * @param implementation Address of implementation contract
     */
    function setMarketImplementation(address implementation) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        require(implementation != address(0), "Invalid implementation");
        marketImplementation = implementation;

        emit MarketImplementationSet(implementation);
    }

    /**
     * @notice Set position tokens contract
     * @param token Address of ViralityPositions contract
     */
    function setPositionsToken(address token) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        require(token != address(0), "Invalid token");
        positionsToken = token;

        emit PositionsTokenSet(token);
    }

    // ============ Market Deployment (Proxy Pattern) ============

    /**
     * @notice Deploy a new market as minimal proxy
     * @dev Only used when useSingleton = false
     * @return proxy Address of deployed proxy
     */
    function deployProxyMarket() 
        external 
        payable
        whenNotPaused 
        onlyRole(DEPLOYER_ROLE)
        returns (address proxy) 
    {
        require(!useSingleton, "Using singleton pattern");
        require(marketImplementation != address(0), "No implementation set");

        if (creationFee > 0) {
            require(msg.value >= creationFee, "Insufficient creation fee");
        }

        proxy = marketImplementation.clone();
        
        deployedProxyMarkets.push(proxy);
        isValidMarket[proxy] = true;

        emit ProxyMarketDeployed(proxy, deployedProxyMarkets.length - 1);
    }

    // ============ View Functions ============

    /**
     * @notice Get the active market contract address
     * @return market Either singleton or latest proxy
     */
    function getActiveMarket() external view returns (address market) {
        if (useSingleton) {
            return singletonMarket;
        } else if (deployedProxyMarkets.length > 0) {
            return deployedProxyMarkets[deployedProxyMarkets.length - 1];
        }
        return address(0);
    }

    /**
     * @notice Get total number of proxy markets deployed
     */
    function getProxyMarketCount() external view returns (uint256) {
        return deployedProxyMarkets.length;
    }

    /**
     * @notice Get proxy markets in a range
     * @param start Start index
     * @param limit Max markets to return
     */
    function getProxyMarkets(uint256 start, uint256 limit) 
        external 
        view 
        returns (address[] memory markets) 
    {
        uint256 end = start + limit;
        if (end > deployedProxyMarkets.length) {
            end = deployedProxyMarkets.length;
        }
        
        uint256 length = end - start;
        markets = new address[](length);
        
        for (uint256 i = 0; i < length; i++) {
            markets[i] = deployedProxyMarkets[start + i];
        }
    }

    /**
     * @notice Get all contract addresses for frontend integration
     */
    function getContracts()
        external
        view
        returns (
            address _singletonMarket,
            address _positionsToken,
            address _treasury,
            address _oracle,
            address _settlementToken
        )
    {
        _singletonMarket = singletonMarket;
        _positionsToken = positionsToken;
        _treasury = treasury;
        _oracle = oracle;
        _settlementToken = settlementToken;
    }

    // ============ Admin Functions ============

    /**
     * @notice Update treasury address
     * @param _treasury New treasury address
     */
    function setTreasury(address _treasury) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        require(_treasury != address(0), "Invalid treasury");
        address old = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(old, _treasury);
    }

    /**
     * @notice Update oracle address
     * @param _oracle New oracle address
     */
    function setOracle(address _oracle) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        require(_oracle != address(0), "Invalid oracle");
        address old = oracle;
        oracle = _oracle;
        emit OracleUpdated(old, _oracle);
    }

    /**
     * @notice Update market creation fee
     * @param fee New fee amount
     */
    function setCreationFee(uint256 fee) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        uint256 old = creationFee;
        creationFee = fee;
        emit CreationFeeUpdated(old, fee);
    }

    /**
     * @notice Update settlement token
     * @param _token New token address (address(0) = native AVAX)
     */
    function setSettlementToken(address _token)
        external
        onlyRole(ADMIN_ROLE)
    {
        address old = settlementToken;
        settlementToken = _token;
        emit SettlementTokenUpdated(old, _token);
    }

    /**
     * @notice Toggle between singleton and proxy patterns
     * @param _useSingleton True for singleton, false for proxies
     */
    function setUseSingleton(bool _useSingleton) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        useSingleton = _useSingleton;
    }

    /**
     * @notice Withdraw collected creation fees
     * @param to Recipient address
     */
    function withdrawFees(address to) 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        require(to != address(0), "Invalid recipient");
        uint256 balance = address(this).balance;
        require(balance > 0, "No fees to withdraw");

        (bool success, ) = to.call{value: balance}("");
        require(success, "Transfer failed");

        emit FeesWithdrawn(to, balance);
    }

    /**
     * @notice Pause factory
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause factory
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ============ Receive ============

    receive() external payable {}
}
