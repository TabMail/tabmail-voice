// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "output.h"
int main() {
    voice::Output output;
    for (auto action : {voice::Action::start, voice::Action::startHandsFree, voice::Action::startAgent, voice::Action::startAgentHandsFree,
         voice::Action::listenHandsFree, voice::Action::finish, voice::Action::cancel,
         voice::Action::toggleMode, voice::Action::closeChat, voice::Action::showHistory}) output.action(action);
    // The chat window's events, between actions: kept in order with them.
    output.chat(voice::ChatEvent::mouseDown);
    output.action(voice::Action::closeChat);
    output.chat(voice::ChatEvent::focusChanged);
    output.send({{"done", true}});
    std::cin.get();
}
