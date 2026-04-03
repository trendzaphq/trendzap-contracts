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
    
    // Natural log of 2 (scaled by PRECISION)
    int256 internal constant LN_2 = 693147180559945309;
    
    // e (Euler's number) scaled by PRECISION
    uint256 internal constant E = 2718281828459045235;
    
    // Maximum input for exp to prevent overflow
    int256 internal constant MAX_EXP_INPUT = 130e18;
    int256 internal constant MIN_EXP_INPUT = -41e18;

    /**
     * @notice Calculate natural logarithm using Halley's method
     * @param x Input value (scaled by PRECISION, must be > 0)
     * @return Natural log scaled by PRECISION
     */
    function ln(uint256 x) internal pure returns (int256) {
        require(x > 0, "ln: zero input");
        
        int256 result = 0;
        uint256 y = x;
        
        // Reduce to [1, 2) range by dividing by 2 repeatedly
        while (y >= 2 * PRECISION) {
            result += LN_2;
            y = y / 2;
        }
        while (y < PRECISION) {
            result -= LN_2;
            y = y * 2;
        }
        
        // Now y is in [1, 2), use Taylor series for ln(1 + z) where z = y - 1
        // ln(1 + z) = z - z²/2 + z³/3 - z⁴/4 + ...
        int256 z = int256(y) - INT_PRECISION;
        int256 zPower = z;
        
        for (uint256 i = 1; i <= 10; i++) {
            if (i % 2 == 1) {
                result += zPower / int256(i);
            } else {
                result -= zPower / int256(i);
            }
            zPower = zPower * z / INT_PRECISION;
            
            // Early exit if term becomes negligible
            if (zPower == 0 || zPower / int256(i + 1) == 0) break;
        }
        
        return result;
    }

    /**
     * @notice Calculate exponential function e^x
     * @param x Input value (scaled by PRECISION)
     * @return e^x scaled by PRECISION
     */
    function exp(int256 x) internal pure returns (uint256) {
        // Handle edge cases
        if (x < MIN_EXP_INPUT) return 0;
        if (x > MAX_EXP_INPUT) revert("exp: overflow");
        if (x == 0) return PRECISION;
        
        // Handle negative exponents
        bool negative = x < 0;
        if (negative) x = -x;
        
        // Reduce x to [0, ln(2)) by computing n such that x = n*ln(2) + r
        int256 n = x / LN_2;
        int256 r = x - n * LN_2;
        
        // Calculate e^r using Taylor series (r is now in [0, ln(2)) ≈ [0, 0.693))
        // e^r = 1 + r + r²/2! + r³/3! + r⁴/4! + ...
        int256 result = INT_PRECISION;
        int256 term = r;
        
        for (uint256 i = 1; i <= 20; i++) {
            result += term;
            term = term * r / INT_PRECISION / int256(i + 1);
            if (term == 0) break;
        }
        
        // Multiply by 2^n to get final result
        // e^x = e^(n*ln(2) + r) = 2^n * e^r
        uint256 finalResult = uint256(result);
        
        if (n > 0) {
            finalResult = finalResult << uint256(n);
        }
        
        // Handle negative exponent: e^(-x) = 1/e^x
        if (negative) {
            finalResult = PRECISION * PRECISION / finalResult;
        }
        
        return finalResult;
    }

    /**
     * @notice Calculate the log-sum-exp for LMSR
     * @dev log(e^a + e^b) = max(a,b) + log(1 + e^(min-max))
     * This is numerically stable
     */
    function logSumExp(int256 a, int256 b) internal pure returns (int256) {
        int256 maxVal = a > b ? a : b;
        int256 minVal = a > b ? b : a;
        
        // log(e^a + e^b) = max + log(1 + e^(min - max))
        int256 diff = minVal - maxVal;
        
        // If diff is very negative, e^diff ≈ 0, so result ≈ max
        if (diff < -40 * INT_PRECISION) {
            return maxVal;
        }
        
        uint256 expDiff = exp(diff);
        int256 logTerm = ln(PRECISION + expDiff);
        
        return maxVal + logTerm;
    }

    /**
     * @notice Multiply two fixed-point numbers
     */
    function mulFP(uint256 a, uint256 b) internal pure returns (uint256) {
        return a * b / PRECISION;
    }

    /**
     * @notice Divide two fixed-point numbers
     */
    function divFP(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0, "div: zero divisor");
        return a * PRECISION / b;
    }
}
