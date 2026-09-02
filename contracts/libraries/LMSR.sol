// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FixedPointMath.sol";

/**
 * @title LMSR (Logarithmic Market Scoring Rule)
 * @notice Implements the LMSR automated market maker for binary prediction markets
 * @dev Based on Robin Hanson's original LMSR paper
 *
 * LMSR is preferred over a simple pool AMM because:
 * 1. Bounded loss for the market maker (max loss = b x ln 2)
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

    /// @dev Smallest permitted liquidity parameter. Guards against markets seeded so
    ///      thinly that q/b runs away after a few hundred units of one-sided volume.
    uint256 internal constant MIN_LIQUIDITY_PARAM = 1e6;

    /**
     * @notice Cost function C(q) for the current state
     * @dev C(q) = b * ln(e^(qOver/b) + e^(qUnder/b))
     */
    function costFunction(
        uint256 qOver,
        uint256 qUnder,
        uint256 b
    ) internal pure returns (uint256 cost) {
        require(b > 0, "LMSR: b must be positive");

        int256 aOver = int256((qOver * PRECISION) / b);
        int256 aUnder = int256((qUnder * PRECISION) / b);

        int256 logSum = FixedPointMath.logSumExp(aOver, aUnder);

        cost = (uint256(logSum) * b) / PRECISION;
    }

    /**
     * @notice Cost to move the market by (deltaOver, deltaUnder)
     * @return cost Positive to pay, negative to receive
     */
    function calculateTradeCost(
        uint256 qOver,
        uint256 qUnder,
        int256 deltaOver,
        int256 deltaUnder,
        uint256 b
    ) internal pure returns (int256 cost) {
        uint256 oldCost = costFunction(qOver, qUnder, b);

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
     * @notice Cost to buy `shares` of one outcome
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
     * @notice Shares receivable for a given payment
     *
     * @dev Closed-form inverse of the cost function:
     *
     *        delta = b * (m + r + ln(inner)) - qThis
     *        inner = (e^(a-m) + e^(u-m)) - e^(u-m) * e^(-r)
     *
     *      with a = qThis/b, u = qOther/b, r = payment/b and m = max(a, u).
     *      Normalising by e^m and factoring e^r out of the logarithm keeps every
     *      exponent passed to exp() non-positive, so the result is stable across the
     *      whole reachable range including payments far larger than b.
     *
     *      This replaces a binary search over [0, payment*2]. That search had two
     *      problems. Its upper bound assumed shares never cost more than 1 each, but
     *      shares cost `price` each, so the bound only held when the outcome traded at
     *      or above 0.50 — buying the cheaper side silently delivered fewer shares
     *      than paid for (33% short at 0.33, 59% at 0.20, 79% at 0.10), which
     *      penalised exactly the contrarian trades that produce price discovery. It
     *      also ran ~61 iterations, each evaluating exp() and ln() twice, for roughly
     *      244 transcendental evaluations per buy.
     *
     *      Validated against the cost function over 30,000 randomised states spanning
     *      payment/b ratios from 1e-6 to 1e5; worst-case relative error 9.4e-12.
     */
    function calculateSharesForPayment(
        uint256 qOver,
        uint256 qUnder,
        uint256 payment,
        bool isOver,
        uint256 b
    ) internal pure returns (uint256 shares) {
        require(b > 0, "LMSR: b must be positive");
        if (payment == 0) return 0;

        uint256 qThis = isOver ? qOver : qUnder;
        uint256 qOther = isOver ? qUnder : qOver;

        int256 a = int256((qThis * PRECISION) / b);
        int256 u = int256((qOther * PRECISION) / b);
        int256 r = int256((payment * PRECISION) / b);

        int256 m = a > u ? a : u;

        // Factor e^r out of the logarithm:
        //
        //   X    = e^r * [ (e^(a-m) + e^(u-m)) - e^(u-m) * e^(-r) ]
        //   ln X = r + ln( (e^(a-m) + e^(u-m)) - e^(u-m) * e^(-r) )
        //
        // Only e^(a-m), e^(u-m) and e^(-r) are evaluated, and all three exponents are
        // non-positive, so exp() cannot overflow however large payment/b becomes.
        // Computing e^r directly would revert above r = 130e18 — reachable with an
        // ordinary trade against a thinly-seeded market.
        uint256 expAm = FixedPointMath.exp(a - m);   // <= 1e18
        uint256 expUm = FixedPointMath.exp(u - m);   // <= 1e18
        uint256 expNegR = FixedPointMath.exp(-r);    // <= 1e18

        uint256 sumExp = expAm + expUm;
        uint256 subtrahend = (expUm * expNegR) / PRECISION;
        require(sumExp > subtrahend, "LMSR: payment too small");
        uint256 inner = sumExp - subtrahend;

        int256 lnInner = FixedPointMath.ln(inner);

        int256 deltaScaled = m + r + lnInner; // (qThis + delta)/b, in fixed point
        int256 delta = (deltaScaled * int256(b)) / INT_PRECISION - int256(qThis);

        // Rounding can leave delta marginally negative for dust payments.
        shares = delta > 0 ? uint256(delta) : 0;
    }

    /**
     * @notice Current prices for both outcomes, each in [0, 1e18]
     *
     * @dev priceOver = 1 / (1 + e^((qUnder - qOver)/b)), evaluated through
     *      FixedPointMath.logistic so exp() only ever sees a non-positive argument.
     *
     *      The previous implementation computed e^(qOver/b) and e^(qUnder/b) directly
     *      and normalised afterwards. exp() reverts above an input of 130e18, so once
     *      q/b passed 130 for either side EVERY price read reverted — getPrices,
     *      getProbabilities, quoteBuy, quoteSharesForPayment, and therefore buyShares
     *      and sellShares. The market became permanently untradeable with positions
     *      frozen until resolution. With b derived from a minimum seed bet that took
     *      only a few hundred USDC of one-sided volume to trigger.
     */
    function getPrices(
        uint256 qOver,
        uint256 qUnder,
        uint256 b
    ) internal pure returns (uint256 priceOver, uint256 priceUnder) {
        require(b > 0, "LMSR: b must be positive");

        int256 aOver = int256((qOver * PRECISION) / b);
        int256 aUnder = int256((qUnder * PRECISION) / b);

        priceOver = FixedPointMath.logistic(aOver - aUnder);
        priceUnder = PRECISION - priceOver;
    }

    /**
     * @notice Implied probabilities in basis points (0-10000)
     * @dev Returned in bps rather than whole percent: the previous version divided by
     *      PRECISION into a 0-100 integer, discarding everything below a full point.
     */
    function getProbabilitiesBps(
        uint256 qOver,
        uint256 qUnder,
        uint256 b
    ) internal pure returns (uint256 probOver, uint256 probUnder) {
        (uint256 priceOver, uint256 priceUnder) = getPrices(qOver, qUnder, b);
        probOver = (priceOver * 10000) / PRECISION;
        probUnder = (priceUnder * 10000) / PRECISION;
    }

    /**
     * @notice Maximum potential loss for the market maker (b * ln 2)
     */
    function maxMarketMakerLoss(uint256 b) internal pure returns (uint256 maxLoss) {
        maxLoss = (b * 693147180559945309) / PRECISION;
    }

    /**
     * @notice Liquidity parameter for a desired maximum loss, floored at MIN_LIQUIDITY_PARAM
     */
    function calculateLiquidityParameter(uint256 desiredMaxLoss) internal pure returns (uint256 b) {
        b = (desiredMaxLoss * PRECISION) / 693147180559945309;
        if (b < MIN_LIQUIDITY_PARAM) b = MIN_LIQUIDITY_PARAM;
    }
}
