// Command line front end for the HYSA projection. Parsing and printing only -
// the arithmetic lives in hysa.hpp so the tests can reach it without a process.
#include <cstdio>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include <string>

#include "hysa.hpp"

namespace {

const char* kUsage =
    "usage: hysa --balance <n> --apy <percent> --years <n> [--monthly <n>]\n"
    "\n"
    "  --balance   starting balance\n"
    "  --apy       advertised annual yield, as a percent (e.g. 4.25)\n"
    "  --years     how long it sits there\n"
    "  --monthly   deposit added at the end of each month (default 0)\n";

// Strip the characters people type into money by habit, so --balance $10,000
// works instead of silently parsing as 0.
std::string strip(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c != '$' && c != ',' && c != '_') out += c;
    }
    return out;
}

double to_number(const std::string& flag, const std::string& raw) {
    const std::string cleaned = strip(raw);
    std::size_t used = 0;
    double value;
    try {
        value = std::stod(cleaned, &used);
    } catch (const std::exception&) {
        throw std::runtime_error("--" + flag + " is not a number: " + raw);
    }
    // stod stops at the first character it cannot use and reports how far it
    // got, so this is what rejects "4.25kg" instead of accepting it as 4.25.
    if (used != cleaned.size()) {
        throw std::runtime_error("--" + flag + " is not a number: " + raw);
    }
    if (value < 0) throw std::runtime_error("--" + flag + " cannot be negative");
    return value;
}

hysa::Inputs parse(int argc, char** argv) {
    std::map<std::string, std::string> flags;
    for (int i = 1; i < argc; i += 2) {
        const std::string key = argv[i];
        if (key.rfind("--", 0) != 0) throw std::runtime_error("expected a --flag, got " + key);
        if (i + 1 >= argc) throw std::runtime_error(key + " needs a value");
        flags[key.substr(2)] = argv[i + 1];
    }

    for (const auto& [key, _] : flags) {
        if (key != "balance" && key != "apy" && key != "years" && key != "monthly") {
            throw std::runtime_error("unknown flag --" + key);
        }
    }

    auto required = [&](const std::string& name) {
        auto it = flags.find(name);
        if (it == flags.end()) throw std::runtime_error("missing --" + name);
        return to_number(name, it->second);
    };

    hysa::Inputs in{};
    in.balance = required("balance");
    in.apy = required("apy") / 100.0;  // typed as a percent, used as a fraction
    in.years = required("years");
    in.monthly = flags.count("monthly") ? to_number("monthly", flags["monthly"]) : 0.0;
    return in;
}

// Thousands separators by hand rather than printf's ' flag, which is a POSIX
// extension that silently does nothing until you set a locale.
std::string with_commas(double amount) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.2f", amount);
    std::string digits(buf);

    const std::size_t dot = digits.find('.');
    std::string whole = digits.substr(0, dot);
    const std::string cents = digits.substr(dot);

    for (std::size_t i = whole.size(); i > 3; i -= 3) {
        whole.insert(i - 3, ",");
    }
    return whole + cents;
}

void print_money(const char* label, double amount) {
    std::printf("%-18s $%s\n", label, with_commas(amount).c_str());
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 1) {
        std::fputs(kUsage, stderr);
        return 1;
    }
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--help" || arg == "-h") {
            std::fputs(kUsage, stdout);
            return 0;
        }
    }

    hysa::Inputs in{};
    try {
        in = parse(argc, argv);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "%s\n\n%s", e.what(), kUsage);
        return 1;
    }

    const hysa::Result r = hysa::project(in);
    if (r.contributed > 0) print_money("you deposited", in.balance + r.contributed);
    print_money("interest earned", r.interest);
    print_money("final balance", r.final_balance);
    return 0;
}
