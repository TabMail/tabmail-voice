// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <softpub.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <shellapi.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace voice {

// What Windows says of a downloaded update's installer (ADR-DESK-050): whether it trusts its
// Authenticode signature, with the certificate chain to a trusted root and revocation checked,
// whose it is, and the product version its signed resources carry. The app decides whether that
// is TabMail's, and the version it was offered.
struct UpdateSignature {
    bool signatureValid = false;
    std::wstring commonName;
    std::wstring organization;
    std::string productVersion;
};

inline std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

inline std::wstring subjectAttribute(PCCERT_CONTEXT certificate, const char* oid) {
    void* type = const_cast<char*>(oid);
    const DWORD size = CertGetNameStringW(certificate, CERT_NAME_ATTR_TYPE, 0, type, nullptr, 0);
    if (size <= 1) return {};
    std::wstring value(size, L'\0');
    CertGetNameStringW(certificate, CERT_NAME_ATTR_TYPE, 0, type, value.data(), size);
    value.resize(size - 1);
    return value;
}

// The fixed product version, a.b.c.d; empty when the file has none.
inline std::string productVersion(const std::wstring& path) {
    DWORD ignored = 0;
    const DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (size == 0) return {};
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return {};
    VS_FIXEDFILEINFO* info = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &length) || info == nullptr || length < sizeof(VS_FIXEDFILEINFO)) return {};
    return std::to_string(HIWORD(info->dwProductVersionMS)) + "." + std::to_string(LOWORD(info->dwProductVersionMS)) + "." +
           std::to_string(HIWORD(info->dwProductVersionLS)) + "." + std::to_string(LOWORD(info->dwProductVersionLS));
}

inline UpdateSignature verifyUpdate(const std::wstring& path) {
    UpdateSignature result;
    WINTRUST_FILE_INFO file{};
    file.cbStruct = sizeof(file);
    file.pcwszFilePath = path.c_str();
    WINTRUST_DATA data{};
    data.cbStruct = sizeof(data);
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &file;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    const HWND noWindow = static_cast<HWND>(INVALID_HANDLE_VALUE);
    if (WinVerifyTrust(noWindow, &action, &data) == ERROR_SUCCESS) {
        CRYPT_PROVIDER_DATA* provider = WTHelperProvDataFromStateData(data.hWVTStateData);
        CRYPT_PROVIDER_SGNR* signer = provider == nullptr ? nullptr : WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0);
        CRYPT_PROVIDER_CERT* certificate = signer == nullptr ? nullptr : WTHelperGetProvCertFromChain(signer, 0);
        if (certificate != nullptr && certificate->pCert != nullptr) {
            result.signatureValid = true;
            result.commonName = subjectAttribute(certificate->pCert, szOID_COMMON_NAME);
            result.organization = subjectAttribute(certificate->pCert, szOID_ORGANIZATION_NAME);
        }
    }
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(noWindow, &action, &data);
    result.productVersion = productVersion(path);
    return result;
}

// `voice-windows.exe --verify-update <path>`: one line of JSON, then exit. The path is read from the
// wide command line, so a user folder with any name works.
inline int runVerifyUpdate() {
    int count = 0;
    LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (arguments == nullptr) return 1;
    const std::wstring path = count == 3 ? arguments[2] : L"";
    LocalFree(arguments);
    if (path.empty()) return 1;
    const UpdateSignature signature = verifyUpdate(path);
    const nlohmann::json reply = {
        {"signatureValid", signature.signatureValid},
        {"commonName", utf8(signature.commonName)},
        {"organization", utf8(signature.organization)},
        {"productVersion", signature.productVersion},
    };
    const std::string text = reply.dump();
    DWORD written = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr) && written == text.size() ? 0 : 1;
}

}
