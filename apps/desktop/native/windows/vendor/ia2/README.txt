IAccessible2 text interface declarations

Source: https://github.com/LinuxA11y/IAccessible2
Revision: c9ae003d9c85eb707716928de97e055f5b77189c
The two IDLs are unmodified upstream files. LICENSE.txt reproduces both BSD notices.

Headers generated with Windows SDK MIDL 8.01.0628:
  midl /nologo /env arm64 /h IA2CommonTypes.h IA2CommonTypes.idl
  midl /nologo /env arm64 /h AccessibleText.h AccessibleText.idl
Only the COM declarations are used (no generated proxy/stub code or runtime DLL).
These declarations use the Windows COM ABI on both x64 and ARM64.
Windows 11 supplies the interface marshaller. An unavailable provider falls back
to the existing UI Automation path. Keep these files together when updating.
