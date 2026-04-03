// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title ViralityPositions
 * @notice ERC1155 tokens representing prediction market positions
 * @dev Each market has two token types: OVER and UNDER
 * 
 * Token ID Encoding:
 * - Token ID = (marketId << 1) | isOver
 * - Even IDs = UNDER positions
 * - Odd IDs = OVER positions
 * 
 * @author TrendZap Team
 */
contract ViralityPositions is ERC1155, AccessControl, ReentrancyGuard {

    // ============ Constants ============

    bytes32 public constant MARKET_ROLE = keccak256("MARKET_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    // ============ State Variables ============

    string public baseURI;
    string public name = "TrendZap Positions";
    string public symbol = "TZAP";

    // Token ID => total supply (manual tracking since we can't use ERC1155Supply)
    mapping(uint256 => uint256) private _totalSupply;

    // Market ID => resolved
    mapping(uint256 => bool) public marketResolved;

    // Market ID => winning side (true = OVER, false = UNDER)  
    mapping(uint256 => bool) public winningOutcome;

    // Market ID => payout per share (in wei, scaled by 1e18)
    mapping(uint256 => uint256) public payoutPerShare;

    // Market ID => total payout pool
    mapping(uint256 => uint256) public payoutPool;

    // Token ID => user => redeemed
    mapping(uint256 => mapping(address => bool)) public hasRedeemed;

    // ============ Events ============

    event PositionMinted(uint256 indexed marketId, address indexed to, bool isOver, uint256 shares);
    event PositionBurned(uint256 indexed marketId, address indexed from, bool isOver, uint256 shares);
    event MarketResolved(uint256 indexed marketId, bool winningOutcomeIsOver, uint256 payoutPerShare);
    event WinningsRedeemed(uint256 indexed marketId, address indexed user, uint256 shares, uint256 payout);
    event PayoutPoolFunded(uint256 indexed marketId, uint256 amount);

    // ============ Constructor ============

    constructor(string memory _baseURI) ERC1155(_baseURI) {
        baseURI = _baseURI;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ============ Token ID Helpers ============

    function getTokenId(uint256 marketId, bool isOver) public pure returns (uint256) {
        return (marketId << 1) | (isOver ? 1 : 0);
    }

    function parseTokenId(uint256 tokenId) public pure returns (uint256 marketId, bool isOver) {
        marketId = tokenId >> 1;
        isOver = (tokenId & 1) == 1;
    }

    // ============ Supply Tracking ============

    function totalSupply(uint256 tokenId) public view returns (uint256) {
        return _totalSupply[tokenId];
    }

    function exists(uint256 tokenId) public view returns (bool) {
        return _totalSupply[tokenId] > 0;
    }

    // ============ Minting & Burning ============

    function mint(
        address to,
        uint256 marketId,
        bool isOver,
        uint256 shares
    ) external onlyRole(MARKET_ROLE) {
        require(shares > 0, "Cannot mint zero");
        require(!marketResolved[marketId], "Market resolved");
        
        uint256 tokenId = getTokenId(marketId, isOver);
        _totalSupply[tokenId] += shares;
        _mint(to, tokenId, shares, "");
        
        emit PositionMinted(marketId, to, isOver, shares);
    }

    function burn(
        address from,
        uint256 marketId,
        bool isOver,
        uint256 shares
    ) external onlyRole(MARKET_ROLE) {
        require(shares > 0, "Cannot burn zero");
        require(!marketResolved[marketId], "Market resolved");
        
        uint256 tokenId = getTokenId(marketId, isOver);
        _totalSupply[tokenId] -= shares;
        _burn(from, tokenId, shares);
        
        emit PositionBurned(marketId, from, isOver, shares);
    }

    // ============ Resolution & Redemption ============

    function fundPayoutPool(uint256 marketId) external payable onlyRole(MARKET_ROLE) {
        require(msg.value > 0, "Must send funds");
        payoutPool[marketId] += msg.value;
        emit PayoutPoolFunded(marketId, msg.value);
    }

    function resolveMarket(
        uint256 marketId,
        bool outcomeIsOver
    ) external onlyRole(RESOLVER_ROLE) {
        require(!marketResolved[marketId], "Already resolved");
        
        marketResolved[marketId] = true;
        winningOutcome[marketId] = outcomeIsOver;
        
        uint256 winningTokenId = getTokenId(marketId, outcomeIsOver);
        uint256 winningSupply = _totalSupply[winningTokenId];
        
        if (winningSupply > 0 && payoutPool[marketId] > 0) {
            payoutPerShare[marketId] = (payoutPool[marketId] * 1e18) / winningSupply;
        }
        
        emit MarketResolved(marketId, outcomeIsOver, payoutPerShare[marketId]);
    }

    function redeem(uint256 marketId) external nonReentrant {
        require(marketResolved[marketId], "Not resolved");
        
        uint256 winningTokenId = getTokenId(marketId, winningOutcome[marketId]);
        uint256 balance = balanceOf(msg.sender, winningTokenId);
        
        require(balance > 0, "No winning tokens");
        require(!hasRedeemed[winningTokenId][msg.sender], "Already redeemed");
        
        hasRedeemed[winningTokenId][msg.sender] = true;
        
        uint256 payout = (balance * payoutPerShare[marketId]) / 1e18;
        require(payout > 0, "Nothing to redeem");
        
        _totalSupply[winningTokenId] -= balance;
        _burn(msg.sender, winningTokenId, balance);
        
        (bool success, ) = msg.sender.call{value: payout}("");
        require(success, "Transfer failed");
        
        emit WinningsRedeemed(marketId, msg.sender, balance, payout);
    }

    // ============ View Functions ============

    function getPosition(uint256 marketId, address user) 
        external 
        view 
        returns (uint256 overShares, uint256 underShares) 
    {
        overShares = balanceOf(user, getTokenId(marketId, true));
        underShares = balanceOf(user, getTokenId(marketId, false));
    }

    function getMarketSupply(uint256 marketId) 
        external 
        view 
        returns (uint256 overSupply, uint256 underSupply) 
    {
        overSupply = _totalSupply[getTokenId(marketId, true)];
        underSupply = _totalSupply[getTokenId(marketId, false)];
    }

    function calculatePotentialPayout(uint256 marketId, address user) 
        external 
        view 
        returns (uint256 payout) 
    {
        if (!marketResolved[marketId]) return 0;
        
        uint256 winningTokenId = getTokenId(marketId, winningOutcome[marketId]);
        uint256 balance = balanceOf(user, winningTokenId);
        
        if (hasRedeemed[winningTokenId][user]) return 0;
        
        payout = (balance * payoutPerShare[marketId]) / 1e18;
    }

    // ============ Metadata ============

    function setBaseURI(string memory newBaseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI = newBaseURI;
    }

    // ============ Required Overrides ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    receive() external payable {}
}
