// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <glib.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <array>
#include <string>

namespace voice {
// Portal restore tokens are opaque, single-use credentials. Never log them.
class PortalToken {
    std::string path;
public:
    explicit PortalToken(std::string location = {}) : path(std::move(location)) {
        if (path.empty()) path = std::string(g_get_user_state_dir()) + "/ai.tabmail.voice/keyboard-portal-token";
    }
    bool available() const { return !read().empty(); }
    std::string take() const {
        auto value = read();
        if (value.empty() || unlink(path.c_str()) != 0) return {};
        return value;
    }
private:
    std::string read() const {
        const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
        if (fd < 0) return {};
        struct stat metadata{};
        std::array<char, 4097> bytes{};
        ssize_t count = -1;
        if (fstat(fd, &metadata) == 0 && S_ISREG(metadata.st_mode) && metadata.st_uid == getuid() &&
            (metadata.st_mode & 077) == 0 && metadata.st_size > 0 && metadata.st_size <= 4096)
            count = ::read(fd, bytes.data(), bytes.size());
        close(fd);
        if (count <= 0 || count > 4096) return {};
        std::string value(bytes.data(), static_cast<size_t>(count));
        return value.find('\0') == std::string::npos ? value : std::string{};
    }
public:
    bool save(const std::string& value) const {
        if (value.empty() || value.size() > 4096 || value.find('\0') != std::string::npos) return false;
        auto directory = path.substr(0, path.find_last_of('/'));
        if (g_mkdir_with_parents(directory.c_str(), 0700) != 0) return false;
        auto temporary = path + ".XXXXXX";
        const int fd = g_mkstemp_full(temporary.data(), O_RDWR | O_CLOEXEC, 0600);
        if (fd < 0) return false;
        size_t offset = 0;
        while (offset < value.size()) {
            const auto written = write(fd, value.data() + offset, value.size() - offset);
            if (written <= 0) break;
            offset += static_cast<size_t>(written);
        }
        bool success = offset == value.size() && fsync(fd) == 0;
        if (close(fd) != 0) success = false;
        if (success) success = rename(temporary.c_str(), path.c_str()) == 0;
        if (!success) unlink(temporary.c_str());
        return success;
    }
};
}
