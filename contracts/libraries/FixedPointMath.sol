// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FixedPointMath
 * @notice Fixed-point math library for LMSR calculations
 * @dev Uses 18 decimal precision (10^18 = 1.0)
 * @author TrendZap Team
 */
library FixedPointMath {
    uint256 internal constant PRECISION = 1e18;
    uint256 internal constant HALF_PRECISION = 5e17;
    int256 internal constant INT_PRECISION = 1e18;

    /// @dev Natural log of 2, scaled by PRECISION
    int256 internal constant LN_2 = 693147180559945309;

    /// @dev sqrt(2), scaled by PRECISION — used to centre the ln() reduction range
    uint256 internal constant SQRT_2 = 1414213562373095049;

    /// @dev e (Euler's number), scaled by PRECISION
    uint256 internal constant E = 2718281828459045235;

    /// @dev Bounds for exp() inputs. Above MAX the uint256 result would overflow.
    int256 internal constant MAX_EXP_INPUT = 130e18;
    int256 internal constant MIN_EXP_INPUT = -41e18;

    /**
     * @notice Natural logarithm.
     * @param x Input value (scaled by PRECISION, must be > 0)
     * @return Natural log scaled by PRECISION
     *
     * @dev Reduces x into [1/sqrt(2), sqrt(2)) then evaluates the inverse-hyperbolic
     *      series ln(x) = 2*atanh(z), z = (x-1)/(x+1).
     *
     *      The previous implementation reduced into [1, 2) and used the direct
     *      alternating series ln(1+z) with 10 terms. That series converges slowly as
     *      z approaches 1: at x near 2 the truncation error was on the order of 9%,
     *      and it fed every trade cost through logSumExp. Centring the range keeps
     *      |z| <= 0.1716, where 10 odd terms are accurate to roughly 1e-17.
     */
    function ln(uint256 x) internal pure returns (int256) {
        require(x > 0, "ln: zero input");

        int256 result = 0;
        uint256 y = x;

        // Reduce into [1/sqrt(2), sqrt(2)), accumulating n*ln(2).
        while (y >= SQRT_2) {
            result += LN_2;
            y >>= 1;
        }
        // (PRECISION * PRECISION) / SQRT_2 == 1/sqrt(2) in fixed point
        uint256 invSqrt2 = (PRECISION * PRECISION) / SQRT_2;
        while (y < invSqrt2) {
            result -= LN_2;
            y <<= 1;
        }

        // z = (y - 1) / (y + 1), with |z| <= 0.1716 over the reduced range.
        int256 yi = int256(y);
        int256 z = ((yi - INT_PRECISION) * INT_PRECISION) / (yi + INT_PRECISION);

        // 2 * (z + z^3/3 + z^5/5 + ... + z^19/19)
        int256 zsq = (z * z) / INT_PRECISION;
        int256 term = z;
        int256 sum = z;
        for (uint256 i = 3; i <= 19; i += 2) {
            term = (term * zsq) / INT_PRECISION;
            if (term == 0) break;
            sum += term / int256(i);
        }

        return result + 2 * sum;
    }

    /**
     * @notice Exponential function e^x
     * @param x Input value (scaled by PRECISION)
     * @return e^x scaled by PRECISION
     */
    function exp(int256 x) internal pure returns (uint256) {
        if (x < MIN_EXP_INPUT) return 0;
        if (x > MAX_EXP_INPUT) revert("exp: overflow");
        if (x == 0) return PRECISION;

        bool negative = x < 0;
        if (negative) x = -x;

        // x = n*ln(2) + r, with r in [0, ln 2)
        int256 n = x / LN_2;
        int256 r = x - n * LN_2;

        // e^r via Taylor series; r < 0.694 so this converges quickly.
        int256 result = INT_PRECISION;
        int256 term = r;

        for (uint256 i = 1; i <= 20; i++) {
            result += term;
            term = ((term * r) / INT_PRECISION) / int256(i + 1);
            if (term == 0) break;
        }

        // e^x = 2^n * e^r
        uint256 finalResult = uint256(result);
        if (n > 0) {
            finalResult <<= uint256(n);
        }

        if (negative) {
            // e^(-x) = 1/e^x
            finalResult = (PRECISION * PRECISION) / finalResult;
        }

        return finalResult;
    }

    /**
     * @notice Numerically stable log(e^a + e^b)
     * @dev log(e^a + e^b) = max(a,b) + log(1 + e^(min-max)); the exponent passed to
     *      exp() is always <= 0, so this never overflows regardless of a and b.
     */
    function logSumExp(int256 a, int256 b) internal pure returns (int256) {
        int256 maxVal = a > b ? a : b;
        int256 minVal = a > b ? b : a;

        int256 diff = minVal - maxVal;

        // e^diff underflows to zero well before -40, so the sum is just max.
        if (diff < -40 * INT_PRECISION) {
            return maxVal;
        }

        uint256 expDiff = exp(diff);
        int256 logTerm = ln(PRECISION + expDiff);

        return maxVal + logTerm;
    }

    /**
     * @notice Logistic function 1 / (1 + e^(-x)), always in (0, 1e18)
     * @dev Used for LMSR prices. Written so exp() only ever receives a non-positive
     *      argument, which is what keeps price reads from reverting at large |x|.
     */
    function logistic(int256 x) internal pure returns (uint256) {
        if (x >= 0) {
            // 1 / (1 + e^-x)
            uint256 e = exp(-x); // x >= 0 so -x <= 0
            return (PRECISION * PRECISION) / (PRECISION + e);
        }
        // e^x / (1 + e^x)
        uint256 ex = exp(x); // x < 0
        return (ex * PRECISION) / (PRECISION + ex);
    }

    /// @notice Multiply two fixed-point numbers
    function mulFP(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / PRECISION;
    }

    /// @notice Divide two fixed-point numbers
    function divFP(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0, "div: zero divisor");
        return (a * PRECISION) / b;
    }
}
