// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "gesture.h"
#include "modifier.h"
#include <iostream>
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

using voice::Action;
using voice::Gesture;
void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
Gesture gesture() { Gesture g; g.tapMaxDuration = 0.2; g.doubleTapWindow = 0.3; return g; }
void doubleTap(Gesture& g) {
    check(g.modifier(true, 1) == Action::start, "first press starts");
    check(g.modifier(false, 1.1) == Action::finish, "first tap finishes");
    check(g.modifier(true, 1.2) == Action::startHandsFree, "second press starts hands free");
    check(g.modifier(false, 1.3) == Action::listenHandsFree, "second tap keeps listening");
}
int main(int argc, char** argv) {
    try {
        check(argc == 2, "shared gesture fixture path required");
        std::ifstream input(argv[1]);
        const auto cases = nlohmann::json::parse(input);
        check(cases.size() == 7, "complete gesture trace census");
        for (const auto& trace : cases) {
            Gesture g;
            g.tapMaxDuration = trace.at("tapMaxDuration");
            g.doubleTapWindow = trace.at("doubleTapWindow");
            for (const auto& step : trace.at("steps")) {
                std::optional<Action> action;
                const auto event = step.at("event").get<std::string>();
                if (event == "down" || event == "up") action = g.modifier(event == "down", step.at("time"), step.value("agent", false));
                else if (event == "key") action = g.keyPressed(step.at("key"), step.value("repeat", false));
                else if (event == "chat") g.chatOpen = step.at("chat");
                else if (event == "ended") g.dictationEnded();
                else throw std::runtime_error("unknown trace event");
                const nlohmann::json actual = action ? nlohmann::json(voice::actionName(*action)) : nlohmann::json(nullptr);
                check(actual == step.at("action"), trace.at("name").get<std::string>().c_str());
                check((g.holding != 0) == step.at("holding") && (g.handsFree != 0) == step.at("handsFree"), "trace state");
                check(g.owns(32) == step.at("space") && g.owns(27) == step.at("escape"), "trace ownership");
            }
        }
        for (const unsigned shift : {0xa0u, 0xa1u}) {
            voice::ModifierChoice choice;
            check(choice.bypass(shift, true, false) && choice.agentIntent(), "either Shift selects agent");
            auto g = gesture();
            check(g.modifier(true, 1, choice.agentIntent()) == Action::startAgent, "Shift starts agent");
            check(!g.modifier(true, 1.1, true), "agent repeat ignored");
            check(choice.bypass(shift, false, false) && !choice.agentIntent(), "Shift release passes through");
            check(g.active(), "Shift release preserves hold");
            check(g.keyPressed(32, false) == Action::toggleMode, "agent Space toggles");
            check(g.modifier(false, 2) == Action::finish, "agent finishes on hotkey release");
            check(choice.bypass(shift, true, false), "late Shift never cancels or toggles");
            choice.seedShifts(false, false);
            check(!choice.agentIntent(), "seed clears stale Shift state");
            choice.bypass(shift, true, true);
            check(!choice.agentIntent(), "injected Shift cannot select agent");
        }
        {
            auto g = gesture();
            g.modifier(true, 1); g.modifier(false, 1.05);
            check(g.modifier(true, 1.1, true) == Action::startAgentHandsFree, "agent double tap intent");
            check(g.modifier(false, 1.15) == Action::listenHandsFree, "agent double tap latches");
            check(g.modifier(true, 1.2, true) == Action::showHistory, "agent triple tap preserves history");
            check(!g.modifier(false, 1.25), "history release owned");
        }

        {
            auto g = gesture();
            check(!g.modifier(false, 0), "unmatched release ignored");
            check(g.modifier(true, 1) == Action::start, "hold starts");
            check(!g.modifier(true, 1.1), "repeat press ignored");
            check(g.owns(32) && !g.owns(27), "hold owns only Space");
            check(g.keyPressed(32, false) == Action::toggleMode, "Space toggles");
            check(!g.keyPressed(32, true), "repeat does not toggle");
            check(g.modifier(false, 2) == Action::finish, "hold finishes");
            check(!g.active() && !g.owns(32), "release frees Space");
        }
        {
            auto g = gesture();
            g.modifier(true, 1);
            check(g.keyPressed(65, false) == Action::cancel, "typing cancels hold");
            check(!g.owns(32), "canceled hold owns no Space");
            check(!g.modifier(false, 1.1), "canceled release does not finish");
            check(g.modifier(true, 1.2) == Action::start, "typing clears double tap");
        }
        {
            auto g = gesture(); doubleTap(g);
            check(g.handsFree && g.owns(32) && g.owns(27), "hands free owns Space and Escape");
            check(!g.keyPressed(65, false) && g.handsFree, "hands free permits typing");
            check(g.keyPressed(32, false) == Action::toggleMode, "hands free toggles");
            check(g.keyPressed(27, false) == Action::cancel, "Escape cancels");
            check(!g.active() && !g.owns(27), "Escape releases ownership");
        }
        {
            auto g = gesture(); doubleTap(g);
            check(g.modifier(true, 1.4) == Action::showHistory, "triple tap shows history");
            check(!g.modifier(false, 1.5), "triple tap release swallowed");
        }
        {
            auto g = gesture(); doubleTap(g);
            check(g.modifier(true, 2) == Action::finish, "later press finishes hands free");
            check(!g.modifier(false, 2.1), "finishing release ignored");
        }
        {
            auto g = gesture();
            g.modifier(true, 1); g.modifier(false, 1.1);
            check(g.modifier(true, 1.2) == Action::startHandsFree, "second press");
            check(g.modifier(false, 2) == Action::finish, "held second press finishes");
            check(!g.handsFree, "held second press not hands free");
        }
        {
            auto g = gesture(); doubleTap(g); g.dictationEnded();
            check(!g.owns(32) && !g.owns(27), "ended dictation frees owned keys");
            check(g.modifier(true, 2) == Action::start, "ended dictation starts afresh");
        }
        {
            auto g = gesture(); g.chatOpen = true; g.modifier(true, 1);
            check(g.owns(27), "chat owns Escape");
            check(g.keyPressed(27, false) == Action::closeChat, "Escape closes chat during hold");
            check(!g.keyPressed(27, true), "repeat does not close twice");
            check(!g.modifier(false, 2), "closed chat release does not finish");
        }
        {
            voice::ModifierChoice keys;
            keys.selected = voice::ModifierChoice::rightAlt;
            check(!keys.bypass(0xa5, true, false), "ordinary right Alt starts the gesture");
            check(!keys.bypass(0xa5, false, false), "ordinary right Alt release reaches the gesture");
            check(!keys.bypass(0xa2, true, false), "Control passes to the app");
            check(keys.bypass(0xa5, true, false), "AltGr right Alt is not swallowed");
            check(keys.bypass(32, true, false), "AltGr Space stays available for typing even in hands-free mode");
            check(keys.bypass(0xa2, false, false), "AltGr Control release passes");
            check(keys.bypass(0xa5, false, false), "AltGr right Alt release passes even when Control ended first");
            check(!keys.bypass(0xa5, true, false), "next standalone right Alt works again");
            keys.bypass(0xa5, false, false);
            check(keys.bypass(0xa2, true, true), "synthesized AltGr Control is tracked without triggering dictation");
            check(keys.bypass(0xa5, true, false), "synthesized Control preserves AltGr");
            keys.bypass(0xa5, false, false);
            keys.bypass(0xa2, false, true);
            check(!keys.bypass(0xa5, true, false), "injected Control release restores ordinary right Alt");
            keys.bypass(0xa5, false, false);
            keys.seedControls(true, false);
            check(keys.bypass(0xa5, true, false), "Control already held when hook installs is respected");
            keys.bypass(0xa5, false, false);
            keys.seedControls(false, false);
            check(keys.bypass(0xa5, true, true), "injected modifier never triggers or steals a key");
            check(!keys.bypass(0xa5, true, false), "injected right Alt does not poison the physical gesture");
        }
        {
            auto g = gesture();
            g.modifier(true, 1); g.modifier(false, 1.1);
            check(g.modifier(true, 1.401) == Action::start, "expired second tap starts an ordinary hold");
            check(g.modifier(false, 1.5) == Action::finish, "expired tap release finishes");
        }
        {
            auto g = gesture(); doubleTap(g);
            check(!g.keyPressed(65, false), "typing during hands free is allowed");
            check(g.modifier(true, 1.4) == Action::finish, "typing clears triple-tap history");
        }
        for (unsigned control : {0xa2u, voice::ModifierChoice::rightControl}) {
            voice::ModifierChoice keys;
            keys.selected = voice::ModifierChoice::rightAlt;
            keys.bypass(control, true, false);
            check(keys.bypass(0xa5, true, false), "either Control plus right Alt stays with the app");
            keys.bypass(control, false, false);
            check(keys.bypass(0xa5, false, false), "chord release remains with the app");
            check(!keys.bypass(0xa5, true, false), "standalone right Alt works after chord release");
        }
        for (const auto& [action, name] : {
            std::pair{Action::start, "start"}, {Action::startHandsFree, "startHandsFree"},
            {Action::listenHandsFree, "listenHandsFree"}, {Action::finish, "finish"},
            {Action::cancel, "cancel"}, {Action::toggleMode, "toggleMode"},
            {Action::closeChat, "closeChat"}, {Action::showHistory, "showHistory"}}) {
            check(std::string(voice::actionName(action)) == name, "action serialization preserves its meaning");
        }
        std::cout << "gesture timing, typing, emitted names and both Control-key policies passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
