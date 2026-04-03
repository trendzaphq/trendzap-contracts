// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FixedPointMath.sol";

/**
 * @title LMSR (Logarithmic Market Scoring Rule)
 * @notice Implements LMSR automated market maker for binary prediction markets
 * @dev Based on Robin Hanson's original LMSR paper
 * 
 * LMSR is preferred over simple pool AMM because:
 * 1. Bounded loss for market maker (max loss = b × ln(2))
 * 2. Continuous pricing without requiring counterparties
 * 3. Better price discovery for binary outcomes
 * 4. Used by professional prediction markets (Augur, Gnosis)
 * 
 * @author TrendZap Team
 */
library LMSR {
    using FixedPointMath for uint256;
    using FixedPointMath for int256;

    uint256 internal constant PRECISION = 1e18;
    int256 internal constant INT_PRECISION = 1e18;

    /**
     * @notice Calculate the cost function C(q) for current state
     * @dev C(q) = b × ln(e^(qOver/b) + e^(qUnder/b))
     * @param qOver Outstanding OVER shares
     * @param qUnder Outstanding UNDER shares  
     * @param b Liquidity parameter (higher = less price sensitivity)
     * @return cost Current cost value
     */
    function costFunction(
        uint256 qOver,
        uint256 qUnder,
        uint256 b
    ) internal pure returns (uint256 cost) {
        require(b > 0, "LMSR: b must be positive");
        
        // Scale q values by b
        int256 aOver = int256(qOver * PRECISION / b);
        int256 aUnder = int256(qUnder * PRECISION / b);
        
        // Use log-sum-exp for numerical stability
        int256 logSum = FixedPointMath.logSumExp(aOver, aUnder);
        
        // Multiply by b to get final cost
        cost = uint256(logSum) * b / PRECISION;
    }

    /**
     * @notice Calculate cost to buy delta shares
     * @param qOver Current OVER shares outstanding
     * @param qUnder Current UNDER shares outstanding
     * @param deltaOver Additional OVER shares to buy (positive) or sell (negative)
     * @param deltaUnder Additional UNDER shares to buy (positive) or sell (negative)
     * @param b Liquidity parameter
     * @return cost Cost to execute the trade (positive = pay, negative = receive)
     */
    function calculateTradeCost(
        uint256 qOver,
        uint256 qUnder,
        int256 deltaOver,
        int256 deltaUnder,
        uint256 b
    ) internal pure returns (int256 cost) {
        uint256 oldCost = costFunction(qOver, qUnder, b);
        
        // Calculate new quantities after trade
        uint256 newQOver;
        uint256 newQUnder;
        
        if (deltaOver >= 0) {
            newQOver = qOver + uint256(deltaOver);
        } else {
            require(qOver >= uint256(-deltaOver), "LMSR: insufficient OVER shares");
            newQOver = qOver - uint256(-deltaOver);
        }
        
        if (deltaUnder >= 0) {
            newQUnder = qUnder + uint256(deltaUnder);
        } else {
            require(qUnder >= uint256(-deltaUnder), "LMSR: insufficient UNDER shares");
            newQUnder = qUnder - uint256(-deltaUnder);
        }
        
        uint256 newCost = costFunction(newQOver, newQUnder, b);
        
        cost = int256(newCost) - int256(oldCost);
    }

    /**
     * @notice Calculate cost to buy shares of one outcome
     * @dev Convenience function for single-outcome trades
     * @param qOver Current OVER shares outstanding
     * @param qUnder Current UNDER shares outstanding
     * @param shares Number of shares to buy
     * @param isOver True if buying OVER, false if buying UNDER
     * @param b Liquidity parameter
     * @return cost Cost to buy the shares
     */
    function calculateBuyCost(
        uint256 qOver,
        uint256 qUnder,
        uint256 shares,
        bool isOver,
        uint256 b
    ) internal pure returns (uint256 cost) {
        int256 deltaOver = isOver ? int256(shares) : int256(0);
        int256 deltaUnder = isOver ? int256(0) : int256(shares);
        
        int256 tradeCost = calculateTradeCost(qOver, qUnder, deltaOver, deltaUnder, b);
        
        require(tradeCost >= 0, "LMSR: negative buy cost");
        cost = uint256(tradeCost);
    }

    /**
     * @notice Calculate shares received for a given payment amount
     * @dev Uses binary search to find optimal shares
     * @param qOver Current OVER shares outstanding
     * @param qUnder Current UNDER shares outstanding
     * @param payment Amount being paid
     * @param isOver True if buying OVER, false if buying UNDER
     * @param b Liquidity parameter
     * @return shares Number of shares that can be bought
     */
    function calculateSharesForPayment(
        uint256 qOver,
        uint256 qUnder,
        uint256 payment,
        bool isOver,
        uint256 b
    ) internal pure returns (uint256 shares) {
        // Binary search for the right number of shares
        uint256 low = 0;
        uint256 high = payment * 2; // Upper bound (shares can't cost more than 1 each)
        
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            uint256 cost = calculateBuyCost(qOver, qUnder, mid, isOver, b);
            
            if (cost <= payment) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        
        shares = low;
    }

    /**
     * @notice Get current price for an outcome
     * @dev Price_OVER = e^(qOver/b) / (e^(qOver/b) + e^(qUnder/b))
     * @param qOver Current OVER shares outstanding
     * @param qUnder Current UNDER shares outstanding
     * @param b Liquidity parameter
     * @return priceOver Price of OVER outcome (0 to 1e18, representing 0 to 100%)
     * @return priceUnder Price of UNDER outcome (0 to 1e18, representing 0 to 100%)
     */
    function getPrices(
        uint256 qOver,
        uint256 qUnder,
        uint256 b
    ) internal pure returns (uint256 priceOver, uint256 priceUnder) {
        require(b > 0, "LMSR: b must be positive");
        
        int256 aOver = int256(qOver * PRECISION / b);
        int256 aUnder = int256(qUnder * PRECISION / b);
        
        uint256 expOver = FixedPointMath.exp(aOver);
        uint256 expUnder = FixedPointMath.exp(aUnder);
        
        uint256 sum = expOver + expUnder;
        
        priceOver = expOver * PRECISION / sum;
        priceUnder = PRECISION - priceOver;
    }

    /**
     * @notice Get implied probability as percentage (0-100)
     * @param qOver Current OVER shares outstanding
     * @param qUnder Current UNDER shares outstanding
     * @param b Liquidity parameter
     * @return probOver Probability of OVER (0-100)
     * @return probUnder Probability of UNDER (0-100)
     */
    function getProbabilities(
        uint256 qOver,
        uint256 qUnder,
        uint256 b
    ) internal pure returns (uint256 probOver, uint256 probUnder) {
        (uint256 priceOver, uint256 priceUnder) = getPrices(qOver, qUnder, b);
        probOver = priceOver * 100 / PRECISION;
        probUnder = priceUnder * 100 / PRECISION;
    }

    /**
     * @notice Calculate maximum potential loss for market maker
     * @dev Max loss occurs when all bets are on one side
     * @param b Liquidity parameter
     * @return maxLoss Maximum potential loss (b × ln(2))
     */
    function maxMarketMakerLoss(uint256 b) internal pure returns (uint256 maxLoss) {
        // ln(2) ≈ 0.693147... represented as 693147180559945309 in PRECISION
        maxLoss = b * 693147180559945309 / PRECISION;
    }

    /**
     * @notice Calculate recommended liquidity parameter based on desired max loss
     * @param desiredMaxLoss Maximum acceptable loss for market maker
     * @return b Recommended liquidity parameter
     */
    function calculateLiquidityParameter(uint256 desiredMaxLoss) internal pure returns (uint256 b) {
        // b = maxLoss / ln(2)
        b = desiredMaxLoss * PRECISION / 693147180559945309;
    }
}
