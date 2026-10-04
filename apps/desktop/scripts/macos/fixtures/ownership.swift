import Foundation
@testable import VoiceMacOSKit

for _ in 0..<128 {
    try autoreleasepool {
        let text = "Synthetic visible label"
        let reducer = try SharedSemanticText(.heading)
        try reducer.offer(.root, text)
        let rendered = try reducer.source()
        precondition(rendered == text)
        let source = text as NSString
        let result = try BoundedCaretSource.read(count: source.length, selection: NSRange(location: 9, length: 0)) {
            source.substring(with: $0) as NSString
        }
        precondition(result.parts == ["Synthetic", "", " visible label"])
        let redacted = try Redactor.redact(text)
        precondition(redacted == text)
    }
    try autoreleasepool {
        let reducer = try SharedSemanticText(.heading)
        do { try reducer.offer(.descendant, "Synthetic rejected label"); fatalError("expected refusal") }
        catch Redactor.Failure.refused {}
        do {
            _ = try BoundedCaretSource.read(count: 20, selection: NSRange(location: 3, length: 0)) { _ in nil }
            fatalError("expected refusal")
        } catch Redactor.Failure.refused {}
    }
}
print("NATIVE_OWNERSHIP_PASS 128 successful and refused cycles")
