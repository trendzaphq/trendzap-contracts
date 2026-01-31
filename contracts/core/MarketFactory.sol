// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ViralityMarket.sol";

/**
 * @title MarketFactory
 * @notice Factory contract for deploying new ViralityMarket instances
 * @dev Creates and tracks all TrendZap prediction markets
 * @author TrendZap Team
 */
contract MarketFactory is Ownable, Pausable {
    // ============ Events ============

    event MarketDeployed(
        address indexed marketAddress,
        address indexed creator,
        uint256 indexed marketIndex
    );

    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ============ State Variables ============

    address public treasury;
    address public oracle;

    address[] public deployedMarkets;
    mapping(address => bool) public isValidMarket;

    // ============ Constructor ============

    constructor(address _treasury, address _oracle) Ownable(msg.sender) {
        require(_treasury != address(0), "Invalid treasury");
        require(_oracle != address(0), "Invalid oracle");

        treasury = _treasury;
        oracle = _oracle;
    }

    // ============ External Functions ============

    /**
     * @notice Deploy a new ViralityMarket contract
     * @return marketAddress The address of the deployed market
     */
    function deployMarket() 
        external 
        whenNotPaused 
        returns (address marketAddress) 
    {
        ViralityMarket market = new ViralityMarket(treasury, oracle);
        marketAddress = address(market);

        deployedMarkets.push(marketAddress);
        isValidMarket[marketAddress] = true;

        emit MarketDeployed(
            marketAddress, 
            msg.sender, 
            deployedMarkets.length - 1
        );
    }

    // ============ View Functions ============

    /**
     * @notice Get total number of deployed markets
     * @return count Number of markets
     */
    function getMarketCount() external view returns (uint256) {
        return deployedMarkets.length;
    }

    /**
     * @notice Get all deployed market addresses
     * @return Array of market addresses
     */
    function getAllMarkets() external view returns (address[] memory) {
        return deployedMarkets;
    }

    /**
     * @notice Get markets in a range (for pagination)
     * @param start Start index
     * @param limit Max markets to return
     * @return Array of market addresses
     */
    function getMarkets(uint256 start, uint256 limit) 
        external 
        view 
        returns (address[] memory) 
    {
        uint256 end = start + limit;
        if (end > deployedMarkets.length) {
            end = deployedMarkets.length;
        }

        address[] memory result = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = deployedMarkets[i];
        }

        return result;
    }

    // ============ Admin Functions ============

    /**
     * @notice Update treasury address
     * @param _treasury New treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury");
        
        address oldTreasury = treasury;
        treasury = _treasury;
        
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /**
     * @notice Update oracle address
     * @param _oracle New oracle address
     */
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        
        address oldOracle = oracle;
        oracle = _oracle;
        
        emit OracleUpdated(oldOracle, _oracle);
    }

    /**
     * @notice Pause market deployments
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause market deployments
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
