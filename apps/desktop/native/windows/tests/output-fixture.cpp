// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "output.h"
int main() {
    voice::Output output;
    for (auto action : {voice::Action::start, voice::Action::startHandsFree,
         voice::Action::listenHandsFree, voice::Action::finish, voice::Action::cancel,
         voice::Action::toggleMode, voice::Action::closeChat, voice::Action::showHistory}) output.action(action);
    output.send({{"done", true}});
    std::cin.get();
}
