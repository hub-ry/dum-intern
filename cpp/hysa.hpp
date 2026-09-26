// The HYSA math, with no I/O in it, so the tests can call it directly.
//
// double, not a fixed-point decimal type. This is a projection whose answer is
// read to the nearest dollar, so a few ulps of drift over 600 multiplications
// does not reach the printed digits. A ledger that has to agree to the cent
// would need decimals instead - float arithmetic cannot represent 0.01.
#pragma once

#include <cmath>

namespace hysa {

struct Inputs {
    double balance;  // starting balance
    double apy;      // as a fraction: 0.0425, NOT 4.25
    double years;
    double monthly;  // deposited at the end of each month; 0 for lump sum
};

struct Result {
    double final_balance;
    double contributed;  // what you deposited, not counting the opening balance
    double interest;
};

// The whole calculator.
//
// The one line that matters is monthly_factor. An APY already has compounding
// folded into it - it is the answer to "how much more money after a year", not
// "how much gets added each period". So going from APY down to one month is
// undoing a 12-fold compounding, which is the twelfth root. Dividing by 12
// would treat the APY as a nominal rate and then compound it a second time:
// (1 + 0.0425/12)^12 = 1.0433, reporting 4.33% on a 4.25% account. Named for
// the convention it holds, because a variable called `rate` is how that bug
// gets in.
inline Result project(const Inputs& in) {
    const long months = static_cast<long>(std::lround(in.years * 12.0));
    const double monthly_factor = std::pow(1.0 + in.apy, 1.0 / 12.0);

    double balance = in.balance;
    for (long i = 0; i < months; ++i) {
        // Growth first, then the deposit. The money you add on payday has not
        // been in the account for that month, so it does not earn for it - and
        // it means the final deposit earns nothing, which is correct.
        balance = balance * monthly_factor + in.monthly;
    }

    const double contributed = in.monthly * static_cast<double>(months);
    return Result{balance, contributed, balance - in.balance - contributed};
}

}  // namespace hysa
