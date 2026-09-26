# Two binaries, no build system beyond this. The math is header-only, so both
# targets are a single compile with nothing to link.
CXX ?= c++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra

.PHONY: all test clean

all: hysa

hysa: hysa.cpp hysa.hpp
	$(CXX) $(CXXFLAGS) -o $@ hysa.cpp

hysa_test: hysa_test.cpp hysa.hpp
	$(CXX) $(CXXFLAGS) -o $@ hysa_test.cpp

test: hysa_test
	./hysa_test

clean:
	rm -f hysa hysa_test
