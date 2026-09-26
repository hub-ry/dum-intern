// A wrong compounding factor still returns a bigger number that grows with
// time, so the bug looks like a correct answer. These pin the figures you can
// work out by hand instead.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "hysa.hpp"

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
    if (!ok) ++failures;
}

void near(double got, double want, const std::string& what, double eps = 0.01) {
    const bool ok = std::fabs(got - want) < eps;
    if (!ok) {
        std::printf("FAIL %s\n       got %.6f, wanted %.6f\n", what.c_str(), got, want);
        ++failures;
        return;
    }
    std::printf("ok   %s\n", what.c_str());
}

}  // namespace

int main() {
    // The test that fails if the compounding is wrong. Dividing the APY by 12
    // would land on 10,433.11 here, overstating the interest by 8 dollars on
    // the first year alone.
    {
        const hysa::Result r = hysa::project({10000.0, 0.0425, 1.0, 0.0});
        near(r.final_balance, 10425.0, "one year at 4.25% APY ends at exactly +4.25%");
        near(r.interest, 425.0, "and the interest is exactly the advertised yield");
    }

    {
        const hysa::Result r = hysa::project({1000.0, 0.0, 3.0, 100.0});
        near(r.final_balance, 4600.0, "zero rate: the balance is only what you put in");
        near(r.contributed, 3600.0, "zero rate: contributions still counted");
        near(r.interest, 0.0, "zero rate: no interest");
    }

    {
        const hysa::Result r = hysa::project({5000.0, 0.05, 0.0, 500.0});
        near(r.final_balance, 5000.0, "zero years: the balance is untouched");
        near(r.contributed, 0.0, "zero years: nothing deposited");
    }

    {
        // One month, and the deposit lands after that month's growth, so it has
        // not been in the account long enough to earn anything.
        const hysa::Result r = hysa::project({0.0, 0.05, 1.0 / 12.0, 100.0});
        near(r.final_balance, 100.0, "the last deposit earns nothing");
        near(r.interest, 0.0, "one month from zero earns no interest");
    }

    {
        // A year of $100 deposits into an empty account. Each one sits for less
        // than the full year, so the interest has to come in under a full
        // year's yield on the total deposited.
        const hysa::Result r = hysa::project({0.0, 0.0425, 1.0, 100.0});
        near(r.contributed, 1200.0, "a year of deposits is 1,200");
        check(r.interest > 0.0, "a year of deposits earns something");
        check(r.interest < 1200.0 * 0.0425, "but less than a full year's yield on the total");
        near(r.final_balance, r.contributed + r.interest,
             "deposits plus interest is the whole balance");
    }

    {
        // Twelve monthly steps have to equal one annual step, or the factor is
        // not really the twelfth root of anything.
        const hysa::Result r = hysa::project({7500.0, 0.038, 1.0, 0.0});
        near(r.final_balance, 7500.0 * 1.038, "twelve monthly steps equal one annual step");
    }

    std::printf("\n%s\n", failures == 0 ? "all passed" : "FAILURES");
    return failures == 0 ? 0 : 1;
}
