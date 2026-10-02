// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include <tinysparql.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <memory>
#include <string>

namespace {
using JSON = nlohmann::json;
template<class T> using Object = std::unique_ptr<T, decltype(&g_object_unref)>;
struct Error {
    GError* value = nullptr;
    ~Error() { if (value) g_error_free(value); }
    void check() { if (value) throw std::runtime_error("search failed"); }
};
// LocalSearch owns the index. Bind every user value as data, never query syntax.
JSON search(const JSON& input) {
    const auto words = input.at("words").get<std::vector<std::string>>();
    const auto scope = input.at("scope").get<std::string>();
    const auto limit = input.at("limit").get<int>();
    if (words.empty() || words.size() > 100 || limit < 1 || limit > 100 ||
        input.at("limit") != limit || !scope.starts_with("file:///") || !scope.ends_with('/')) throw std::runtime_error("invalid search");
    std::string query = R"(SELECT DISTINCT ?url ?name ?changed (COALESCE(?mime, '') AS ?type) WHERE {
        GRAPH tracker:FileSystem { ?file a nfo:FileDataObject ; nie:url ?url ; nfo:fileName ?name .
          OPTIONAL { ?file nfo:fileLastModified ?changed }
        }
        OPTIONAL { ?content nie:isStoredAs ?file .
          OPTIONAL { ?content nie:mimeType ?mime }
          OPTIONAL { ?content nie:title ?title }
          OPTIONAL { ?content nie:plainTextContent ?text }
        }
        FILTER(STRSTARTS(?url, ~scope))
    )";
    for (size_t i = 0; i < words.size(); ++i) {
        if (words[i].empty() || words[i].size() > 2048 || words[i].find('\0') != std::string::npos || !g_utf8_validate(words[i].c_str(), -1, nullptr)) throw std::runtime_error("invalid word");
        query += " FILTER(CONTAINS(LCASE(CONCAT(?name, ' ', COALESCE(?title, ''), ' ', COALESCE(?text, ''))), LCASE(~word" + std::to_string(i) + ")))\n";
    }
    const auto kind = input.at("kind").get<std::string>();
    if (kind == "pdf") query += " FILTER(?mime = 'application/pdf')";
    else if (kind == "image") query += " FILTER(STRSTARTS(?mime, 'image/'))";
    else if (kind == "folder") query += " FILTER(EXISTS { ?file a nfo:Folder })";
    else if (kind == "document") query += " FILTER(EXISTS { ?content a nfo:Document })";
    else if (kind == "presentation") query += " FILTER(EXISTS { ?content a nfo:Presentation })";
    else if (kind == "spreadsheet") query += " FILTER(EXISTS { ?content a nfo:Spreadsheet })";
    else if (kind == "email") query += " FILTER(?mime = 'message/rfc822')";
    else if (kind != "any") throw std::runtime_error("invalid kind");
    if (!input.at("after").is_null()) query += " FILTER(?changed >= ~after)";
    if (!input.at("before").is_null()) query += " FILTER(?changed < ~before)";
    query += " } ORDER BY DESC(?changed) LIMIT " + std::to_string(limit);
    Error error;
    Object<TrackerSparqlConnection> connection(tracker_sparql_connection_bus_new("org.freedesktop.LocalSearch3", nullptr, nullptr, &error.value), g_object_unref);
    error.check(); if (!connection) throw std::runtime_error("no search service");
    Object<TrackerSparqlStatement> statement(tracker_sparql_connection_query_statement(connection.get(), query.c_str(), nullptr, &error.value), g_object_unref);
    error.check(); if (!statement) throw std::runtime_error("no statement");
    tracker_sparql_statement_bind_string(statement.get(), "scope", scope.c_str());
    for (size_t i = 0; i < words.size(); ++i) tracker_sparql_statement_bind_string(statement.get(), ("word" + std::to_string(i)).c_str(), words[i].c_str());
    for (const auto key : {"after", "before"}) if (!input.at(key).is_null()) {
        const auto value = input.at(key).get<std::string>();
        if (value.size() > 32 || value.find('\0') != std::string::npos) throw std::runtime_error("invalid date");
        std::unique_ptr<GDateTime, decltype(&g_date_time_unref)> date(g_date_time_new_from_iso8601(value.c_str(), nullptr), g_date_time_unref);
        if (!date) throw std::runtime_error("invalid date");
        tracker_sparql_statement_bind_datetime(statement.get(), key, date.get());
    }
    Object<TrackerSparqlCursor> cursor(tracker_sparql_statement_execute(statement.get(), nullptr, &error.value), g_object_unref);
    error.check(); if (!cursor) throw std::runtime_error("no result");
    JSON rows = JSON::array();
    while (tracker_sparql_cursor_next(cursor.get(), nullptr, &error.value)) {
        JSON row = JSON::array();
        for (int col = 0; col < 4; ++col) {
            const auto value = tracker_sparql_cursor_get_string(cursor.get(), col, nullptr);
            row.push_back(value ? JSON(value) : JSON(nullptr));
        }
        rows.push_back(row);
        if (rows.size() >= static_cast<size_t>(limit)) break;
    }
    error.check();
    return rows;
}
}
// One bounded request per process: searches cannot delay audio, focus or paste.
// The Electron caller owns the timeout and kills this process on expiry.
int main() {
    try {
        std::string line;
        char ch;
        while (std::cin.get(ch) && ch != '\n') {
            if (line.size() >= 256 * 1024) return 1;
            line += ch;
        }
        std::cout << search(JSON::parse(line)).dump() << '\n';
        return 0;
    } catch (...) { std::cerr << "file search failed\n"; return 1; }
}
