// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "activation_retry.h"
#include <cstdlib>
#include <iostream>
using voice::ActivationRetry;
void check(bool condition) { if (!condition) std::abort(); }
int main() {
    ActivationRetry retry;
    check(!retry.take(0));
    retry.enter(10, 0);
    auto first = retry.take(0); check(first.has_value()); check(!retry.take(0));
    retry.complete(*first, true, 10); check(!retry.next()); check(!retry.take(100000));
    retry.enter(20, 100000);
    for (unsigned i = 0; i < 5; ++i) {
        const auto now = uint64_t(100000 + i * 1000);
        auto attempt = retry.take(now); check(attempt.has_value());
        retry.complete(*attempt, false, now);
        check(!retry.take(now + 999));
    }
    check(!retry.next()); check(!retry.take(1000000));
    // Away/back asks again, including after success or exhausted attempts.
    retry.enter(10, 1000000); auto old = retry.take(1000000); check(old.has_value());
    retry.enter(20, 1000001);
    retry.complete(*old, false, 1000002);
    check(retry.next() == 1000001);
    auto current = retry.take(1000002); check(current && current->target == 20);
    retry.enter(0, 1000003); retry.complete(*current, false, 1000004);
    check(!retry.next());
    retry.enter(20, 1000005); check(retry.take(1000005).has_value());
    retry.enter(10, 2000000);
    auto previousVisit = retry.take(2000000); check(previousVisit.has_value());
    retry.enter(20, 2000001);
    retry.enter(10, 2000002);
    retry.complete(*previousVisit, false, 2000003);
    check(retry.next() == 2000002);
    auto newVisit = retry.take(2000003);
    check(newVisit && newVisit->target == 10 && newVisit->generation != previousVisit->generation);
    retry.complete(*newVisit, true, 2000004); check(!retry.next());
    std::cout << "foreground retry bounds, cancellation and revisit checks passed\n";
}
