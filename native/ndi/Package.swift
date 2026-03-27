// swift-tools-version: 6.0
import PackageDescription
import Foundation

let sdkDirectory = ProcessInfo.processInfo.environment["NDI_SDK_DIR"] ?? "/Library/NDI SDK for Apple"
let libraryDirectory = "\(sdkDirectory)/lib/macOS"

let package = Package(
  name: "WintercircusNDIAdapter",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(
      name: "wintercircus-ndi-adapter",
      targets: ["WintercircusNDIAdapter"],
    ),
  ],
  targets: [
    .systemLibrary(
      name: "CNDI",
      path: "Sources/CNDI",
    ),
    .executableTarget(
      name: "WintercircusNDIAdapter",
      dependencies: ["CNDI"],
      linkerSettings: [
        .unsafeFlags([
          "-L", libraryDirectory,
          "-Xlinker", "-rpath",
          "-Xlinker", libraryDirectory,
          "-lndi",
        ]),
      ],
    ),
  ],
)
