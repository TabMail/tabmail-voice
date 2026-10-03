# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
cmake_minimum_required(VERSION 3.24)
project(TabMailVoiceLinux LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(PkgConfig REQUIRED)
pkg_check_modules(ATSPI REQUIRED IMPORTED_TARGET atspi-2>=2.56 gobject-2.0 gio-unix-2.0)
pkg_check_modules(PULSE REQUIRED IMPORTED_TARGET libpulse-mainloop-glib)
pkg_check_modules(IBUS REQUIRED IMPORTED_TARGET ibus-1.0)
find_package(nlohmann_json 3.11 REQUIRED)
find_package(Threads REQUIRED)
find_package(ICU REQUIRED COMPONENTS uc i18n)
add_executable(voice-hotkey src/hotkey.cpp)
target_link_libraries(voice-hotkey PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json Threads::Threads)
target_compile_options(voice-hotkey PRIVATE -Wall -Wextra -Werror)
add_executable(voice-linux src/system.cpp)
target_link_libraries(voice-linux PRIVATE PkgConfig::ATSPI PkgConfig::PULSE PkgConfig::IBUS nlohmann_json::nlohmann_json Threads::Threads ICU::uc ICU::i18n)
target_compile_options(voice-linux PRIVATE -Wall -Wextra -Werror)
pkg_check_modules(SPARQL REQUIRED IMPORTED_TARGET tinysparql-3.0)
add_executable(voice-files src/files.cpp)
target_link_libraries(voice-files PRIVATE PkgConfig::SPARQL nlohmann_json::nlohmann_json)
target_compile_options(voice-files PRIVATE -Wall -Wextra -Werror)
include(CTest)
if(BUILD_TESTING)
  add_executable(voice-gesture-tests ../windows/tests/gesture.cpp)
  target_include_directories(voice-gesture-tests PRIVATE ../shared/hotkey ../windows/src)
  target_compile_options(voice-gesture-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-gesture COMMAND voice-gesture-tests)
  add_executable(voice-redactor-tests tests/redactor.cpp)
  target_link_libraries(voice-redactor-tests PRIVATE nlohmann_json::nlohmann_json ICU::uc ICU::i18n)
  target_compile_options(voice-redactor-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-redactor COMMAND voice-redactor-tests "${CMAKE_CURRENT_SOURCE_DIR}/../shared/privacy/redaction-cases.json")
  find_program(DBUS_RUN_SESSION dbus-run-session REQUIRED)
  find_program(PYTHON_EXECUTABLE python3 REQUIRED)
  add_executable(voice-accessibility-bridge-tests tests/accessibility-bridge.cpp)
  target_link_libraries(voice-accessibility-bridge-tests PRIVATE PkgConfig::ATSPI Threads::Threads)
  target_compile_options(voice-accessibility-bridge-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-accessibility-bridge COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- $<TARGET_FILE:voice-accessibility-bridge-tests>)
  set_tests_properties(voice-accessibility-bridge PROPERTIES TIMEOUT 10)
  add_executable(voice-input-session-tests tests/input-session.cpp)
  target_link_libraries(voice-input-session-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-input-session-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-input-session COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- $<TARGET_FILE:voice-input-session-tests>)
  set_tests_properties(voice-input-session PROPERTIES TIMEOUT 12)
  add_executable(voice-shortcut-tests tests/portal-hotkey.cpp)
  target_link_libraries(voice-shortcut-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-shortcut-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-shortcut COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/shortcut-output.py" $<TARGET_FILE:voice-shortcut-tests>)
  set_tests_properties(voice-shortcut PROPERTIES TIMEOUT 12)
  add_executable(voice-gnome-controls-tests tests/gnome-controls.cpp)
  target_link_libraries(voice-gnome-controls-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-gnome-controls-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-gnome-controls COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/gnome-controls-output.py" $<TARGET_FILE:voice-gnome-controls-tests>)
  set_tests_properties(voice-gnome-controls PROPERTIES TIMEOUT 8)
  add_executable(voice-gnome-caret-tests tests/gnome-caret.cpp)
  target_link_libraries(voice-gnome-caret-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-gnome-caret-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-gnome-caret COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- $<TARGET_FILE:voice-gnome-caret-tests>)
  set_tests_properties(voice-gnome-caret PROPERTIES TIMEOUT 8)
  add_executable(voice-keyboard-language-tests tests/keyboard-language.cpp)
  target_link_libraries(voice-keyboard-language-tests PRIVATE PkgConfig::ATSPI PkgConfig::IBUS nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-keyboard-language-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-keyboard-language COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- $<TARGET_FILE:voice-keyboard-language-tests>)
  set_tests_properties(voice-keyboard-language PROPERTIES TIMEOUT 8)
  add_executable(voice-ipc-bounds-fixture tests/ipc-bounds.cpp)
  target_link_libraries(voice-ipc-bounds-fixture PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-ipc-bounds-fixture PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-ipc-bounds COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/ipc-bounds.py" $<TARGET_FILE:voice-ipc-bounds-fixture>)
  set_tests_properties(voice-ipc-bounds PROPERTIES TIMEOUT 15)
  add_test(NAME voice-files COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/files.py" $<TARGET_FILE:voice-files>)
  set_tests_properties(voice-files PROPERTIES TIMEOUT 20)
  add_test(NAME voice-portal-owner COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/portal-owner.py" $<TARGET_FILE:voice-hotkey> $<TARGET_FILE:voice-linux>)
  set_tests_properties(voice-portal-owner PROPERTIES RUN_SERIAL TRUE TIMEOUT 20)
  add_test(NAME voice-gnome-protocol COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/gnome-protocol.py" $<TARGET_FILE:voice-hotkey> $<TARGET_FILE:voice-linux>)
  set_tests_properties(voice-gnome-protocol PROPERTIES TIMEOUT 15)
  find_program(NODE_EXECUTABLE node REQUIRED)
  add_test(NAME voice-gnome-extension COMMAND ${NODE_EXECUTABLE} --experimental-vm-modules --test "${CMAKE_CURRENT_SOURCE_DIR}/gnome/extension.test.mjs")
  set_tests_properties(voice-gnome-extension PROPERTIES TIMEOUT 8)
  add_test(NAME voice-hotkey-protocol COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${NODE_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/hotkey-protocol.mjs" $<TARGET_FILE:voice-hotkey>)
  set_tests_properties(voice-hotkey-protocol PROPERTIES RUN_SERIAL TRUE TIMEOUT 20)
  add_executable(voice-microphone-fixture tests/microphone.cpp)
  target_link_libraries(voice-microphone-fixture PRIVATE PkgConfig::PULSE nlohmann_json::nlohmann_json Threads::Threads)
  target_compile_options(voice-microphone-fixture PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-microphone COMMAND ${NODE_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/microphone.mjs" $<TARGET_FILE:voice-microphone-fixture>)
  set_tests_properties(voice-microphone PROPERTIES RUN_SERIAL TRUE TIMEOUT 20)
  add_test(NAME voice-system-protocol COMMAND ${NODE_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/system-protocol.mjs" $<TARGET_FILE:voice-linux>)
  set_tests_properties(voice-system-protocol PROPERTIES RUN_SERIAL TRUE TIMEOUT 20)
  add_executable(voice-context-tests ../windows/tests/screen-context.cpp)
  target_include_directories(voice-context-tests PRIVATE ../shared/context)
  target_compile_options(voice-context-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-context COMMAND voice-context-tests)
  add_executable(voice-privacy-tests tests/privacy.cpp)
  target_link_libraries(voice-privacy-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json)
  target_compile_options(voice-privacy-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-privacy COMMAND voice-privacy-tests "${CMAKE_CURRENT_SOURCE_DIR}/../shared/privacy/host-exclusion-cases.json")
  add_executable(voice-screen-tests tests/screen.cpp)
  target_link_libraries(voice-screen-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json ICU::uc ICU::i18n)
  target_compile_options(voice-screen-tests PRIVATE -Wall -Wextra -Werror)
  add_test(NAME voice-screen COMMAND voice-screen-tests)
  add_executable(voice-screen-collection-tests tests/screen-collection.cpp)
  target_link_libraries(voice-screen-collection-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json ICU::uc ICU::i18n)
  target_compile_options(voice-screen-collection-tests PRIVATE -Wall -Wextra -Werror)
  target_link_options(voice-screen-collection-tests PRIVATE
    -Wl,--wrap=atspi_accessible_get_collection_iface -Wl,--wrap=atspi_collection_get_matches
    -Wl,--wrap=g_array_unref -Wl,--wrap=atspi_accessible_clear_cache)
  add_test(NAME voice-screen-collection COMMAND voice-screen-collection-tests)
  add_executable(voice-browser-accessibility-tests tests/browser-accessibility.cpp)
  target_link_libraries(voice-browser-accessibility-tests PRIVATE PkgConfig::ATSPI nlohmann_json::nlohmann_json ICU::uc ICU::i18n)
  target_compile_options(voice-browser-accessibility-tests PRIVATE -Wall -Wextra -Werror)
  target_link_options(voice-browser-accessibility-tests PRIVATE
    -Wl,--wrap=atspi_accessible_clear_cache -Wl,--wrap=atspi_accessible_get_attributes
    -Wl,--wrap=atspi_accessible_get_child_count -Wl,--wrap=atspi_accessible_get_child_at_index
    -Wl,--wrap=atspi_accessible_get_role -Wl,--wrap=atspi_accessible_get_document_iface
    -Wl,--wrap=atspi_document_get_document_attributes)
  add_test(NAME voice-browser-accessibility COMMAND voice-browser-accessibility-tests)
  add_executable(voice-foreground-fixture src/system.cpp tests/foreground-provider.cpp)
  target_link_libraries(voice-foreground-fixture PRIVATE PkgConfig::ATSPI PkgConfig::PULSE PkgConfig::IBUS nlohmann_json::nlohmann_json Threads::Threads ICU::uc ICU::i18n)
  target_compile_options(voice-foreground-fixture PRIVATE -Wall -Wextra -Werror)
  target_link_options(voice-foreground-fixture PRIVATE
    -Wl,--wrap=atspi_init
    -Wl,--wrap=atspi_event_main
    -Wl,--wrap=atspi_event_listener_new
    -Wl,--wrap=atspi_event_listener_register
    -Wl,--wrap=atspi_event_listener_deregister
    -Wl,--wrap=atspi_get_desktop
    -Wl,--wrap=atspi_accessible_clear_cache
    -Wl,--wrap=atspi_accessible_get_attributes
    -Wl,--wrap=atspi_accessible_get_role
    -Wl,--wrap=atspi_accessible_get_state_set
    -Wl,--wrap=atspi_accessible_get_child_count
    -Wl,--wrap=atspi_accessible_get_child_at_index
    -Wl,--wrap=atspi_accessible_get_parent
    -Wl,--wrap=atspi_accessible_get_process_id
    -Wl,--wrap=atspi_accessible_get_collection_iface
    -Wl,--wrap=atspi_accessible_get_component_iface
    -Wl,--wrap=atspi_accessible_get_document_iface
    -Wl,--wrap=atspi_document_get_document_attributes
    -Wl,--wrap=atspi_accessible_get_name
    -Wl,--wrap=atspi_accessible_get_text_iface
    -Wl,--wrap=atspi_text_get_character_count
    -Wl,--wrap=atspi_text_get_caret_offset
    -Wl,--wrap=atspi_text_get_n_selections
    -Wl,--wrap=atspi_text_get_text
)
  add_test(NAME voice-foreground-lifecycle COMMAND ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/private-session.py" ${DBUS_RUN_SESSION} -- ${PYTHON_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/foreground-lifecycle.py" $<TARGET_FILE:voice-foreground-fixture>)
  set_tests_properties(voice-foreground-lifecycle PROPERTIES TIMEOUT 20)
  add_test(NAME voice-accessibility COMMAND ${NODE_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/accessibility.mjs" $<TARGET_FILE:voice-linux> "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixture.py")
  set_tests_properties(voice-accessibility PROPERTIES RUN_SERIAL TRUE TIMEOUT 30)
endif()
