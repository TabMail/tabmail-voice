// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/channel.h"
int main(int argc, char**) {
    voice::Output output;
    if (argc > 1) {
        // Flood only once the parent has read the first line: the writer thread may not have run yet,
        // and a queue that fills before it writes anything ends the helper with nothing to show.
        output.send({{"sequence", 0}, {"payload", std::string(4096, 'x')}});
        char go;
        if (::read(0, &go, 1) != 1) return 2;
        for (int i = 1; i < 400; ++i) output.send({{"sequence", i}, {"payload", std::string(4096, 'x')}});
        if (::write(2, "enqueued400\n", 12) != 12) return 2;
        std::this_thread::sleep_for(std::chrono::seconds(10));
        return 0;
    }
    voice::Channel channel(output, [](const std::string&, const auto& params, auto reply, int64_t) { reply(params, true); });
    auto loop = g_main_loop_new(nullptr, false);
    g_main_loop_run(loop);
}
